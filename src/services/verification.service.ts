import { ai, GEMINI_MODEL } from '../config.js'
import { safeText } from '../utils.js'
import { VerificationResult, type VerificationStatus } from '../db.js'
import { fetchHubspotContactsDirect } from './hubspot.service.js'
import { findLinkedInForContact, fetchLinkedInProfileData } from './linkedin.service.js'

// ---- AI-powered field comparison ----

interface CompareResult {
  matches: boolean
  confidence: number
  explanation: string
}

export async function compareFields(
  fieldName: string,
  hubspotValue: string,
  linkedinValue: string
): Promise<CompareResult> {
  if (!hubspotValue && !linkedinValue) {
    return { matches: true, confidence: 1.0, explanation: 'Both fields are empty' }
  }
  if (!hubspotValue || !linkedinValue) {
    return { matches: false, confidence: 0.5, explanation: `One field is empty: HubSpot="${hubspotValue}", LinkedIn="${linkedinValue}"` }
  }

  // Quick exact match check
  if (hubspotValue.toLowerCase().trim() === linkedinValue.toLowerCase().trim()) {
    return { matches: true, confidence: 1.0, explanation: 'Exact match' }
  }

  // Use AI for semantic comparison
  const prompt = `You are a data comparison assistant. Compare these two values for the field "${fieldName}" and determine if they refer to the same thing.

CRM (HubSpot) value: "${hubspotValue}"
LinkedIn value: "${linkedinValue}"

Rules:
- For company names: "Microsoft Corporation" and "Microsoft" are a MATCH. "Google" and "Alphabet" are a MATCH. But "Nike" and "Adidas" are NOT a match.
- For job titles: "VP of Sales" and "Vice President of Sales" are a MATCH. "VP of Sales" and "SVP of Sales" is a DISCREPANCY (same field, different seniority). "Marketing Manager" and "VP of Marketing" is a DISCREPANCY.
- Only return NOT matching if the values clearly refer to different entities/roles.

Return ONLY a compact JSON object — no markdown fences, no explanation outside the JSON:
{"matches":true,"confidence":0.95,"explanation":"Brief reason"}

confidence is 0.0–1.0 indicating how sure you are of the match/mismatch decision.`

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
    })
    const raw = (response.text || '').trim()
    const jsonMatch = raw.match(/\{[\s\S]*?\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        matches: Boolean(parsed.matches),
        confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5)),
        explanation: String(parsed.explanation || '').trim()
      }
    }
  } catch (err) {
    console.error('[compareFields] AI comparison failed:', err)
  }

  // Fallback: simple substring check
  const hsLower = hubspotValue.toLowerCase().trim()
  const liLower = linkedinValue.toLowerCase().trim()
  const substringMatch = hsLower.includes(liLower) || liLower.includes(hsLower)
  return {
    matches: substringMatch,
    confidence: substringMatch ? 0.7 : 0.3,
    explanation: substringMatch ? 'Substring match (AI comparison unavailable)' : 'No substring match (AI comparison unavailable)'
  }
}

// ---- AI summary generation ----

export async function generateAiSummary(
  hubspotData: { fullName: string; company: string; jobTitle: string },
  linkedinData: { currentCompany: string; currentTitle: string; name: string },
  status: VerificationStatus
): Promise<{ summary: string; confidence: number }> {
  const statusDescriptions: Record<VerificationStatus, string> = {
    match: 'The HubSpot CRM data matches what LinkedIn shows',
    stale: 'The lead has MOVED to a different company',
    discrepancy: 'The lead is at the same company but has a different job title (likely a promotion or role change)',
    unverified: 'The verification could not be completed',
    error: 'An error occurred during verification',
    not_found: 'The LinkedIn profile could not be found',
  }

  const prompt = `You are a concise CRM data analyst. Write a 1-2 sentence summary explaining the verification result for this lead.

Status: ${status.toUpperCase()} — ${statusDescriptions[status]}

HubSpot CRM Data:
- Name: ${hubspotData.fullName}
- Company: ${hubspotData.company}
- Job Title: ${hubspotData.jobTitle}

LinkedIn Data:
- Company: ${linkedinData.currentCompany || 'unknown'}
- Title: ${linkedinData.currentTitle || 'unknown'}

Instructions:
- Write in third person (use the person's first name)
- Be specific about what changed
- If stale, mention the old and new company
- If discrepancy, mention the old and new title
- Keep it factual and under 2 sentences
- Do NOT use markdown formatting

Example outputs:
- "John moved from Nike to Adidas, now serving as Senior Director of Digital Commerce."
- "Sarah was promoted from Marketing Manager to VP of Marketing at Salesforce."
- "Michael's records are up to date — still serving as CTO at Stripe."

Return ONLY the summary text, nothing else.`

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
    })
    const summary = (response.text || '').trim()
    return { summary, confidence: 0.85 }
  } catch (err) {
    console.error('[generateAiSummary] Failed:', err)
    // Fallback summary
    const name = hubspotData.fullName.split(' ')[0] || 'Lead'
    switch (status) {
      case 'match':
        return { summary: `${name}'s records are up to date at ${hubspotData.company}.`, confidence: 0.5 }
      case 'stale':
        return { summary: `${name} appears to have moved from ${hubspotData.company} to ${linkedinData.currentCompany || 'a new company'}.`, confidence: 0.5 }
      case 'discrepancy':
        return { summary: `${name} is still at ${hubspotData.company} but their role has changed from ${hubspotData.jobTitle} to ${linkedinData.currentTitle || 'a new role'}.`, confidence: 0.5 }
      default:
        return { summary: `Verification for ${name} is ${status}.`, confidence: 0.3 }
    }
  }
}

// ---- Core verification: single contact ----

export async function verifyContact(contact: any, batchId: string): Promise<any> {
  const firstName = safeText(contact.properties?.firstname)
  const lastName = safeText(contact.properties?.lastname)
  const fullName = `${firstName} ${lastName}`.trim()
  const hsCompany = safeText(contact.properties?.company)
  const hsJobTitle = safeText(contact.properties?.jobtitle)
  const hsEmail = safeText(contact.properties?.email)
  const hsLinkedinUrl = safeText(contact.properties?.hs_linkedin_url || contact.properties?.linkedin_url || '')
  const hsIndustry = safeText(contact.properties?.industry)
  const hsLeadStatus = safeText(contact.properties?.hs_lead_status)

  const hubspotData = {
    firstName,
    lastName,
    fullName,
    company: hsCompany,
    jobTitle: hsJobTitle,
    email: hsEmail,
    linkedinUrl: hsLinkedinUrl,
    industry: hsIndustry,
    leadStatus: hsLeadStatus,
  }

  // Step 1: Find LinkedIn profile
  let linkedinProfileUrl = hsLinkedinUrl
  let linkedinDiscoveryConfidence = hsLinkedinUrl ? 0.9 : 0

  let geminiDiscoveryResult: Awaited<ReturnType<typeof findLinkedInForContact>> = null

  if (!linkedinProfileUrl) {
    // Use the Gemini agent to discover LinkedIn URL
    try {
      const result = await findLinkedInForContact(contact)
      geminiDiscoveryResult = result
      if (result && result.profileUrl && result.confidence >= 0.4) {
        linkedinProfileUrl = result.profileUrl
        linkedinDiscoveryConfidence = result.confidence
      }
    } catch (err: any) {
      console.error(`[verify] LinkedIn discovery failed for ${fullName}:`, err.message)
    }
  }

  // If no LinkedIn URL found but Gemini found intel (company/title), use that for verification
  if (!linkedinProfileUrl && geminiDiscoveryResult?.company) {
    console.log(`[verify] ${fullName}: No LinkedIn URL but Gemini found intel — company="${geminiDiscoveryResult.company}" title="${geminiDiscoveryResult.title}"`)

    const linkedinData = {
      profileUrl: '',
      name: geminiDiscoveryResult.name || fullName,
      currentCompany: geminiDiscoveryResult.company,
      currentTitle: geminiDiscoveryResult.title,
      headline: '',
      location: '',
    }

    // Skip to comparison using Gemini intel
    let status: VerificationStatus = 'unverified'
    const changes = {
      previousCompany: hsCompany,
      previousTitle: hsJobTitle,
      newCompany: linkedinData.currentCompany,
      newTitle: linkedinData.currentTitle,
      companyChanged: false,
      titleChanged: false,
    }

    const companyComparison = await compareFields('company', hsCompany, linkedinData.currentCompany)
    const titleComparison = await compareFields('job title', hsJobTitle, linkedinData.currentTitle)

    changes.companyChanged = !companyComparison.matches
    changes.titleChanged = !titleComparison.matches

    if (companyComparison.matches && titleComparison.matches) {
      status = 'match'
    } else if (!companyComparison.matches) {
      status = 'stale'
    } else {
      status = 'discrepancy'
    }

    const { summary: aiSummary, confidence: aiConfidence } = await generateAiSummary(
      hubspotData, linkedinData, status
    )

    const saved = await VerificationResult.findOneAndUpdate(
      { hubspotContactId: contact.id, batchId },
      {
        hubspotContactId: contact.id, hubspotData, linkedinData, status, changes,
        aiSummary, aiConfidence, batchId, verifiedAt: new Date(),
      },
      { upsert: true, new: true }
    )

    console.log(`[verify] ${fullName} @ ${hsCompany} → ${status} (Gemini intel: ${linkedinData.currentCompany} / ${linkedinData.currentTitle})`)
    return saved
  }

  // If no LinkedIn profile found at all, return not_found
  if (!linkedinProfileUrl) {
    const notFoundResult = {
      hubspotContactId: contact.id,
      hubspotData,
      linkedinData: { profileUrl: '', name: '', currentCompany: '', currentTitle: '', headline: '', location: '' },
      status: 'not_found' as VerificationStatus,
      changes: { previousCompany: '', previousTitle: '', newCompany: '', newTitle: '', companyChanged: false, titleChanged: false },
      aiSummary: `Could not find a LinkedIn profile for ${fullName} at ${hsCompany}.`,
      aiConfidence: 0,
      batchId,
      verifiedAt: new Date(),
    }

    const saved = await VerificationResult.findOneAndUpdate(
      { hubspotContactId: contact.id, batchId },
      notFoundResult,
      { upsert: true, new: true }
    )
    return saved
  }

  // Step 2: Fetch LinkedIn profile data, then enrich with Gemini discovery intel
  let linkedinData = {
    profileUrl: linkedinProfileUrl,
    name: '',
    currentCompany: '',
    currentTitle: '',
    headline: '',
    location: '',
  }

  try {
    const profileData = await fetchLinkedInProfileData(linkedinProfileUrl)
    if (profileData) {
      linkedinData = profileData
    }
  } catch (err: any) {
    console.error(`[verify] LinkedIn fetch failed for ${fullName}:`, err.message)
  }

  // Enrich with Gemini discovery intel if the scraped data is missing or looks wrong
  // (LinkedIn public pages often show "Location | Professional Profile" instead of real company,
  //  or slug probing can match a different person with the same name)
  if (geminiDiscoveryResult) {
    const companyLooksBad = !linkedinData.currentCompany ||
      linkedinData.currentCompany.toLowerCase().includes('professional profile') ||
      linkedinData.currentCompany.toLowerCase().includes('united states') ||
      linkedinData.currentCompany.toLowerCase().includes('linkedin')
    const titleMissing = !linkedinData.currentTitle

    // Also override when: Gemini found a company, the probe found a DIFFERENT company,
    // and the probe company doesn't match HubSpot either — likely a different person with the same name
    const probeCompanyConflictsWithGemini = geminiDiscoveryResult.company &&
      linkedinData.currentCompany &&
      !companyLooksBad &&
      linkedinData.currentCompany.toLowerCase() !== geminiDiscoveryResult.company.toLowerCase() &&
      linkedinData.currentCompany.toLowerCase() !== hsCompany.toLowerCase()

    if ((companyLooksBad || probeCompanyConflictsWithGemini) && geminiDiscoveryResult.company) {
      if (probeCompanyConflictsWithGemini) {
        console.log(`[verify] Probe found "${linkedinData.currentCompany}" but Gemini says "${geminiDiscoveryResult.company}" — likely wrong person, using Gemini intel`)
      }
      linkedinData.currentCompany = geminiDiscoveryResult.company
    }
    if ((titleMissing || probeCompanyConflictsWithGemini) && geminiDiscoveryResult.title) {
      linkedinData.currentTitle = geminiDiscoveryResult.title
    }
  }

  // Step 3: Compare fields using AI
  let status: VerificationStatus = 'unverified'
  const changes = {
    previousCompany: hsCompany,
    previousTitle: hsJobTitle,
    newCompany: linkedinData.currentCompany,
    newTitle: linkedinData.currentTitle,
    companyChanged: false,
    titleChanged: false,
  }

  if (!linkedinData.currentCompany && !linkedinData.currentTitle) {
    // LinkedIn data is empty — can't verify
    status = 'error'
  } else {
    // Compare company
    const companyComparison = await compareFields('company', hsCompany, linkedinData.currentCompany)
    // Compare title
    const titleComparison = await compareFields('job title', hsJobTitle, linkedinData.currentTitle)

    changes.companyChanged = !companyComparison.matches
    changes.titleChanged = !titleComparison.matches

    if (companyComparison.matches && titleComparison.matches) {
      status = 'match'
    } else if (!companyComparison.matches) {
      status = 'stale' // Different company = stale lead
    } else {
      status = 'discrepancy' // Same company, different title = role change
    }
  }

  // Step 4: Generate AI summary
  const { summary: aiSummary, confidence: aiConfidence } = await generateAiSummary(
    hubspotData, linkedinData, status
  )

  // Step 5: Save result
  const verificationDoc = {
    hubspotContactId: contact.id,
    hubspotData,
    linkedinData,
    status,
    changes,
    aiSummary,
    aiConfidence,
    batchId,
    verifiedAt: new Date(),
  }

  const saved = await VerificationResult.findOneAndUpdate(
    { hubspotContactId: contact.id, batchId },
    verificationDoc,
    { upsert: true, new: true }
  )

  console.log(`[verify] ${fullName} @ ${hsCompany} → ${status} (LinkedIn: ${linkedinData.currentCompany || 'n/a'} / ${linkedinData.currentTitle || 'n/a'})`)
  return saved
}

// ---- Batch verification ----

export async function verifyBatch(options: {
  filters?: {
    industry?: string
    company?: string
    role?: string
    region?: string
    lastUpdatedDays?: number
    leadStatus?: string
  }
  limit?: number
  after?: string
}): Promise<{
  batchId: string
  processed: number
  results: Record<VerificationStatus, number>
  nextCursor: string | null
  verifications: any[]
}> {
  const limit = Math.min(options.limit || 10, 25) // Cap at 25 per call (Gemini rate limits)
  const batchId = `batch_${Date.now()}`

  // Fetch contacts from HubSpot with filters
  const { contacts, nextCursor } = await fetchHubspotContactsDirect({
    limit,
    after: options.after,
    filters: options.filters,
  })

  // Filter to contacts that have enough data
  const eligible = contacts.filter(ct => {
    const hasName = safeText(ct.properties?.firstname) || safeText(ct.properties?.lastname)
    const hasCompany = safeText(ct.properties?.company)
    return hasName && hasCompany
  })

  const verifications: any[] = []
  const statusCounts: Record<VerificationStatus, number> = {
    match: 0,
    stale: 0,
    discrepancy: 0,
    unverified: 0,
    error: 0,
    not_found: 0,
  }

  for (const contact of eligible) {
    try {
      const result = await verifyContact(contact, batchId)
      verifications.push(result)
      statusCounts[result.status as VerificationStatus]++
    } catch (err: any) {
      console.error(`[verifyBatch] Error for contact ${contact.id}:`, err.message)
      statusCounts.error++
    }
  }

  return {
    batchId,
    processed: contacts.length,
    results: statusCounts,
    nextCursor,
    verifications,
  }
}

// ---- Dashboard queries ----

export async function getVerificationStats() {
  const pipeline = [
    { $match: { discarded: { $ne: true } } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        avgConfidence: { $avg: '$aiConfidence' },
      }
    }
  ]

  const results = await VerificationResult.aggregate(pipeline)

  const stats: Record<string, number> = {
    total: 0,
    match: 0,
    stale: 0,
    discrepancy: 0,
    not_found: 0,
    error: 0,
    unverified: 0,
  }

  let totalConfidence = 0
  let confidenceCount = 0

  for (const r of results) {
    stats[r._id] = r.count
    stats.total += r.count
    if (r.avgConfidence) {
      totalConfidence += r.avgConfidence * r.count
      confidenceCount += r.count
    }
  }

  const lastVerification = await VerificationResult.findOne({ discarded: { $ne: true } })
    .sort({ verifiedAt: -1 }).select('verifiedAt').lean() as any

  return {
    ...stats,
    lastRunAt: lastVerification?.verifiedAt || null,
    averageConfidence: confidenceCount > 0 ? Number((totalConfidence / confidenceCount).toFixed(2)) : 0,
  }
}

export async function getVerificationResults(options: {
  status?: string
  batchId?: string
  limit?: number
  offset?: number
  search?: string
  discarded?: boolean
}) {
  const query: any = {}

  if (options.status && options.status !== 'all') {
    query.status = options.status
  }
  if (options.batchId) {
    query.batchId = options.batchId
  }
  if (!options.discarded) {
    query.discarded = { $ne: true }
  }
  if (options.search) {
    const searchRegex = new RegExp(options.search, 'i')
    query.$or = [
      { 'hubspotData.fullName': searchRegex },
      { 'hubspotData.company': searchRegex },
      { 'linkedinData.name': searchRegex },
      { 'linkedinData.currentCompany': searchRegex },
      { 'hubspotData.email': searchRegex },
    ]
  }

  const limit = Math.min(options.limit || 50, 200)
  const offset = options.offset || 0

  const [results, total] = await Promise.all([
    VerificationResult.find(query)
      .sort({ verifiedAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean(),
    VerificationResult.countDocuments(query),
  ])

  return { results, total, limit, offset }
}
