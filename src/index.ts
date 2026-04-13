import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { GoogleGenAI } from '@google/genai'
import { readFileSync } from 'fs'
import { join } from 'path'
import 'dotenv/config';
import nodemailer from 'nodemailer';
import mongoose from 'mongoose';

const app = new Hono()

app.use('/*', cors())

// Connect to MongoDB
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB successfully'))
    .catch((err) => console.error('MongoDB connection error:', err));
} else {
  console.warn('MONGODB_URI is not set. Grouping features will not work until a database is configured.');
}

// Define the Group schema definition
const groupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  contacts: [{
    identifier: { type: String, required: true }, // Email, Profile URL, or HubSpot ID
    leadSource: { type: String, required: true }, // 'linkedin' or 'hubspot'
    name: { type: String }, 
    company: { type: String },
  }]
});

const Group = mongoose.models.Group || mongoose.model('Group', groupSchema);

type LeadSector = 'retail' | 'real_estate' | 'retail_tech' | 'commerce' | 'unknown'

const TARGET_SECTORS: LeadSector[] = ['retail', 'real_estate', 'retail_tech', 'commerce']
const C_SUITE_KEYWORDS = ['ceo', 'coo', 'cto', 'cfo', 'cro', 'cmo', 'cio', 'chief', 'president', 'founder']
const AGENT_MIN_CONFIDENCE = Number(process.env.AGENT_MIN_CONFIDENCE || '0.65')
const CRAWL_COOLDOWN_MS = Number(process.env.AGENT_CRAWL_COOLDOWN_MS || String(6 * 60 * 60 * 1000))
const MAX_AGENT_RESULTS = Number(process.env.AGENT_MAX_RESULTS || '50')

const agentLeadSchema = new mongoose.Schema({
  identifier: { type: String, required: true, unique: true, index: true },
  profileUrl: { type: String, default: '' },
  name: { type: String, default: '' },
  title: { type: String, default: '' },
  company: { type: String, default: '' },
  sector: { type: String, enum: [...TARGET_SECTORS, 'unknown'], default: 'unknown' },
  isCSuite: { type: Boolean, required: true },
  confidence: { type: Number, min: 0, max: 1, required: true },
  provenance: {
    sourceUrl: { type: String, required: true },
    fetchedAt: { type: Date, required: true },
    method: { type: String, required: true }
  },
  signals: {
    titleMatch: { type: Boolean, required: true },
    sectorMatch: { type: Boolean, required: true },
    companyMatch: { type: Boolean, required: true }
  },
  raw: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true })

const crawlAttemptSchema = new mongoose.Schema({
  url: { type: String, required: true },
  normalizedUrl: { type: String, required: true, index: true },
  query: { type: String, default: '' },
  status: { type: String, enum: ['success', 'failed', 'blocked', 'skipped'], required: true },
  reason: { type: String, default: '' },
  responseStatus: { type: Number },
  attemptedAt: { type: Date, default: Date.now, index: true }
}, { timestamps: false })

const AgentLead = mongoose.models.AgentLead || mongoose.model('AgentLead', agentLeadSchema)
const CrawlAttempt = mongoose.models.CrawlAttempt || mongoose.model('CrawlAttempt', crawlAttemptSchema)

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

function loadJsonArray(relativePath: string, label: string): any[] {
  try {
    const filePath = join(process.cwd(), 'src', relativePath)
    const data = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(data)
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    console.error(`Error loading ${label}:`, e)
    return []
  }
}

function normalizeLinkedinLead(lead: any) {
  const normalizedCompany = lead.company || lead.companyName || ''
  const normalizedCompanyWebsite = lead.companyWebsite || lead.website || ''
  const normalizedProfileUrl = lead.profileUrl || lead.url || ''
  const normalizedEmail = lead.email || (Array.isArray(lead.emails) ? lead.emails[0] : undefined)

  return {
    ...lead,
    profileUrl: normalizedProfileUrl,
    url: lead.url || normalizedProfileUrl,
    company: normalizedCompany,
    companyName: lead.companyName || normalizedCompany,
    companyWebsite: normalizedCompanyWebsite,
    email: normalizedEmail,
  }
}

function getLeadIdentityKey(lead: any) {
  return (
    lead.profileUrl ||
    lead.url ||
    lead.email ||
    lead.name ||
    JSON.stringify(lead)
  ).toLowerCase()
}

function normalizeProfileUrl(rawUrl?: string) {
  if (!rawUrl || typeof rawUrl !== 'string') return ''
  try {
    const parsed = new URL(rawUrl.trim())
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase()
    const normalizedPath = parsed.pathname.replace(/\/$/, '').toLowerCase()
    return `${parsed.protocol}//${host}${normalizedPath}`
  } catch {
    return rawUrl.trim().toLowerCase().replace(/\/$/, '')
  }
}

function toStableIdentifier(candidate: any) {
  const normalizedUrl = normalizeProfileUrl(candidate.profileUrl || candidate.url || candidate.provenance?.sourceUrl)
  return (normalizedUrl || candidate.email || candidate.name || '').toLowerCase().trim()
}

function inferSector(input?: string) {
  if (!input) return 'unknown' as LeadSector
  const value = input.toLowerCase()
  if (value.includes('real estate') || value.includes('property')) return 'real_estate'
  if (value.includes('retail tech') || value.includes('commerce tech')) return 'retail_tech'
  if (value.includes('commerce') || value.includes('ecommerce') || value.includes('e-commerce')) return 'commerce'
  if (value.includes('retail')) return 'retail'
  return 'unknown'
}

function isCSuiteTitle(title?: string) {
  if (!title) return false
  const normalized = title.toLowerCase()
  return C_SUITE_KEYWORDS.some(keyword => normalized.includes(keyword))
}

function dedupeByIdentifier<T extends { identifier: string }>(items: T[]) {
  const map = new Map<string, T>()
  for (const item of items) {
    if (!item.identifier) continue
    if (!map.has(item.identifier)) {
      map.set(item.identifier, item)
    }
  }
  return Array.from(map.values())
}

function extractLinkedinProfileUrls(html: string) {
  const profileRegex = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]+\/?/g
  const directMatches = html.match(profileRegex) || []
  const decodedMatches: string[] = []

  const encodedRegex = /uddg=([^&"'\s]+)/g
  let encodedMatch: RegExpExecArray | null = null
  while ((encodedMatch = encodedRegex.exec(html)) !== null) {
    try {
      const decoded = decodeURIComponent(encodedMatch[1])
      if (/linkedin\.com\/in\//i.test(decoded)) {
        decodedMatches.push(decoded)
      }
    } catch {
      // ignore malformed URI segments
    }
  }

  const all = [...directMatches, ...decodedMatches]
  return Array.from(new Set(all.map(normalizeProfileUrl).filter(url => /linkedin\.com\/in\//.test(url))))
}

function safeText(value: any) {
  return typeof value === 'string' ? value.trim() : ''
}

function deriveConfidence(signals: { titleMatch: boolean, sectorMatch: boolean, companyMatch: boolean }, hasName: boolean, hasPublicSource: boolean) {
  let score = 0.2
  if (signals.titleMatch) score += 0.35
  if (signals.sectorMatch) score += 0.2
  if (signals.companyMatch) score += 0.15
  if (hasName) score += 0.1
  if (hasPublicSource) score += 0.1
  return Math.max(0, Math.min(1, Number(score.toFixed(2))))
}

function parseLinkedinTitlePage(titleText: string) {
  // LinkedIn page title format: "Name - Company | LinkedIn"
  // Strip the "| LinkedIn" suffix first, then split on " - "
  const withoutSuffix = titleText.replace(/\s*\|\s*LinkedIn\s*$/i, '').trim()
  const parts = withoutSuffix.split(' - ').map(p => p.trim()).filter(Boolean)
  const name = parts[0] || ''
  // Everything after the first dash is the company (title is NOT in the page title)
  const company = parts.slice(1).join(' - ').trim()
  return { name, title: '', company }
}

function extractJobTitleFromMeta(metaDescription: string): string {
  if (!metaDescription) return ''

  // Pattern 1: "Name\nTitle | Description..." — the second line is often the title
  const lines = metaDescription.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length >= 2) {
    const candidateLine = lines[1].split('|')[0].trim()
    if (candidateLine.length > 0 && candidateLine.length < 120) return candidateLine
  }

  // Pattern 2: Explicit C-suite keyword anywhere in the description
  const csuitePattern = /\b(CEO|COO|CTO|CFO|CRO|CMO|CIO|Chief\s+[\w\s]+Officer|President|Founder|Co-?Founder|Managing\s+Director|Executive\s+Director|Operations\s+Director|General\s+Manager)\b/i
  const m = metaDescription.match(csuitePattern)
  if (m) return m[0].trim()

  return ''
}

async function aiExtractProfileSignals(
  pageTitle: string,
  metaDescription: string,
  profileUrl: string
): Promise<{ name: string; title: string; company: string; isCSuite: boolean; sector: string } | null> {
  const snippet = [pageTitle, metaDescription].filter(Boolean).join('\n').trim()
  if (!snippet) return null

  const prompt = `You are a data extraction assistant. Extract structured fields from this LinkedIn profile snippet.

Page Title: ${pageTitle}
Meta Description: ${metaDescription}
Profile URL: ${profileUrl}

Return ONLY a compact JSON object — no markdown fences, no explanation:
{"name":"","title":"","company":"","isCSuite":false,"sector":"unknown"}

sector must be one of: retail, real_estate, retail_tech, commerce, unknown
isCSuite is true only if the person holds a C-suite, President, Founder, or Managing/Executive Director title.`

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    })
    const raw = (response.text || '').trim()
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    const parsed = JSON.parse(jsonMatch[0])
    return {
      name: String(parsed.name || '').trim(),
      title: String(parsed.title || '').trim(),
      company: String(parsed.company || '').trim(),
      isCSuite: Boolean(parsed.isCSuite),
      sector: String(parsed.sector || 'unknown').trim(),
    }
  } catch {
    return null
  }
}

function buildSectorCompanyQueries(companies: string[] = [], sectors: LeadSector[] = TARGET_SECTORS, titles: string[] = ['CEO', 'COO', 'CRO', 'CTO']) {
  const effectiveCompanies = companies.filter(Boolean)
  const effectiveSectors = sectors.length ? sectors : TARGET_SECTORS
  const queries: string[] = []

  if (effectiveCompanies.length > 0) {
    for (const company of effectiveCompanies) {
      for (const title of titles) {
        queries.push(`site:linkedin.com/in "${title}" "${company}"`)
        queries.push(`linkedin.com/in "${title}" "${company}"`)
      }
    }
  } else {
    const sectorLabels: Record<LeadSector, string[]> = {
      retail: ['retail', 'consumer goods'],
      real_estate: ['real estate', 'property'],
      retail_tech: ['retail tech', 'commerce technology'],
      commerce: ['ecommerce', 'e-commerce', 'commerce'],
      unknown: [],
    }
    for (const sector of effectiveSectors) {
      const labels = sectorLabels[sector] || [sector.replace('_', ' ')]
      for (const label of labels.slice(0, 1)) {
        for (const title of titles) {
          queries.push(`site:linkedin.com/in "${title}" "${label}"`)
          queries.push(`linkedin "${title}" "${label}" site:linkedin.com`)
        }
      }
    }
  }

  return queries
}

async function recordCrawlAttempt(attempt: { url: string, normalizedUrl: string, query?: string, status: 'success' | 'failed' | 'blocked' | 'skipped', reason?: string, responseStatus?: number }) {
  if (mongoose.connection.readyState !== 1) return
  try {
    await CrawlAttempt.create({
      url: attempt.url,
      normalizedUrl: attempt.normalizedUrl,
      query: attempt.query || '',
      status: attempt.status,
      reason: attempt.reason || '',
      responseStatus: attempt.responseStatus,
      attemptedAt: new Date()
    })
  } catch (error) {
    console.error('Failed to record crawl attempt:', error)
  }
}

async function shouldSkipDueToCooldown(normalizedUrl: string) {
  if (!normalizedUrl || mongoose.connection.readyState !== 1) return false
  try {
    const latest = await CrawlAttempt.findOne({ normalizedUrl, status: { $in: ['failed', 'blocked'] } }).sort({ attemptedAt: -1 }).lean()
    if (!latest?.attemptedAt) return false
    return (Date.now() - new Date(latest.attemptedAt).getTime()) < CRAWL_COOLDOWN_MS
  } catch {
    return false
  }
}

// Load and merge lead sources with LinkedIn-first precedence/order
const baseLeads = loadJsonArray('leads.json', 'leads.json')
const linkedinLeadsRaw = loadJsonArray('linkedin.json', 'linkedin.json')
const linkedinLeads = linkedinLeadsRaw.map(normalizeLinkedinLead)

const leadMap = new Map<string, any>()
for (const lead of linkedinLeads) {
  leadMap.set(getLeadIdentityKey(lead), lead)
}

for (const lead of baseLeads) {
  const key = getLeadIdentityKey(lead)
  if (!leadMap.has(key)) {
    leadMap.set(key, lead)
  }
}

let leads: any[] = Array.from(leadMap.values())
console.log(`Loaded ${linkedinLeads.length} LinkedIn leads first, plus ${baseLeads.length} base leads (deduped)`)

// Load hubspot contacts
const hubspotPath = join(process.cwd(), 'src', 'hubspot.json')
let hubspotContacts: any[] = []
try {
  const data = readFileSync(hubspotPath, 'utf8')
  const parsed = JSON.parse(data)
  hubspotContacts = parsed.results || []
  console.log(`Loaded ${hubspotContacts.length} HubSpot contacts`);
} catch (e) {
  console.error("Error loading hubspot.json:", e)
}

let hubspotCursor: string | undefined = undefined;
let isFetchingHubspot = false;

async function ensureHubspotContacts(requiredCount: number) {
  if (hubspotContacts.length >= requiredCount) return;
  if (isFetchingHubspot) {
    while (isFetchingHubspot && hubspotContacts.length < requiredCount) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (hubspotContacts.length >= requiredCount) return;
  }
  
  isFetchingHubspot = true;
  try {
    const ht = process.env.HUBSPOT_TOKEN;
    if (!ht) {
      console.warn("HUBSPOT_TOKEN is not set. Cannot fetch more contacts.");
      return;
    }

    const existingIds = new Set(hubspotContacts.map(c => c.id));
    let i = 0;

    while (hubspotContacts.length < requiredCount) {
      const url = new URL("https://api.hubapi.com/crm/v3/objects/contacts");
      url.searchParams.set("limit", "100");
      url.searchParams.append("properties", "firstname");
      url.searchParams.append("properties", "lastname");
      url.searchParams.append("properties", "email");
      url.searchParams.append("properties", "company");
      url.searchParams.append("properties", "jobtitle");
      url.searchParams.append("properties", "hs_email_last_open_date");
      url.searchParams.append("properties", "hs_email_last_click_date");
      url.searchParams.append("properties", "industry");
      url.searchParams.append("properties", "notes_last_activity_date");

      if (hubspotCursor) {
        url.searchParams.set("after", hubspotCursor);
      }

      console.log(`Fetching more HubSpot contacts (required: ${requiredCount}, current: ${hubspotContacts.length})...`);
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${ht}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        console.error(`HubSpot API error: ${res.status} ${res.statusText}`);
        break;
      }

      const data = await res.json();
      if (!data.results || data.results.length === 0) break;

      let added = 0;
      for (const contact of data.results) {
        if (!existingIds.has(contact.id)) {
          hubspotContacts.push(contact);
          existingIds.add(contact.id);
          added++;
        }
      }
      
      console.log(`Fetched ${data.results.length} contacts, added ${added} novel ones. Total: ${hubspotContacts.length}`);

      if (data.paging?.next?.after) {
        hubspotCursor = data.paging.next.after;
        if (i > 500) break;
        i++;
      } else {
        break;
      }
    }
  } catch (err) {
    console.error("Error ensuring HubSpot contacts:", err);
  } finally {
    isFetchingHubspot = false;
  }
}

function apiError(code: string, message: string, details?: any) {
  return { error: { code, message, details: details || null } }
}

// ---- Gemini Tool implementations for the hubspot-to-linkedin agent ----

async function toolSearchWeb(query: string): Promise<string> {
  if (!query) return 'empty query'
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  try {
    const response = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadIntakeBot/1.0; +https://coresight.com)' }
    })
    if (!response.ok) {
      const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
      const bingRes = await fetch(bingUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadIntakeBot/1.0; +https://coresight.com)' }
      })
      if (!bingRes.ok) return `Search failed: ${response.status}`
      const html = await bingRes.text()
      const urls = extractLinkedinProfileUrls(html)
      return JSON.stringify({ linkedinUrls: urls.slice(0, 5), source: 'bing' })
    }
    const html = await response.text()
    const urls = extractLinkedinProfileUrls(html)
    return JSON.stringify({ linkedinUrls: urls.slice(0, 5), source: 'duckduckgo' })
  } catch (e: any) {
    return `Search error: ${e.message}`
  }
}

async function toolFetchLinkedInPage(url: string): Promise<string> {
  const normalizedUrl = normalizeProfileUrl(url)
  if (!normalizedUrl || !/linkedin\.com\/in\//i.test(normalizedUrl)) {
    return 'Only linkedin.com/in/ profile URLs are supported'
  }
  try {
    const response = await fetch(normalizedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadIntakeBot/1.0; +https://coresight.com)' }
    })
    if (!response.ok) return `Fetch failed: ${response.status}`
    const html = await response.text()
    const titleMatch = html.match(/<title>(.*?)<\/title>/i)
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    const pageTitle = safeText(titleMatch?.[1] || '')
    const metaDescription = safeText(descMatch?.[1] || '')
    const parsed = parseLinkedinTitlePage(pageTitle)
    const inferredTitle = extractJobTitleFromMeta(metaDescription)
    return JSON.stringify({ url: normalizedUrl, pageTitle, metaDescription, parsedName: parsed.name, parsedCompany: parsed.company, inferredTitle })
  } catch (e: any) {
    return `Fetch error: ${e.message}`
  }
}

const LINKEDIN_TOOL_DECLARATIONS = [
  {
    name: 'search_web',
    description: 'Search DuckDuckGo (with Bing fallback) for LinkedIn profiles. Returns an array of linkedin.com/in/ URLs found.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, e.g. "John Smith CEO Acme Corp site:linkedin.com/in"' }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_linkedin_page',
    description: 'Fetch a LinkedIn profile page and return its page title and meta description to confirm the person\'s name, title, and company.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full linkedin.com/in/ profile URL to fetch' }
      },
      required: ['url']
    }
  }
]

async function findLinkedInForContact(contact: any): Promise<{ profileUrl: string; name: string; title: string; company: string; confidence: number } | null> {
  const firstName = safeText(contact.properties?.firstname)
  const lastName = safeText(contact.properties?.lastname)
  const name = `${firstName} ${lastName}`.trim()
  const company = safeText(contact.properties?.company)
  const title = safeText(contact.properties?.jobtitle)

  if (!name) return null

  const userPrompt = `Find the LinkedIn profile URL for this person:
Name: ${name}
Company: ${company || 'unknown'}
Title: ${title || 'unknown'}

Steps:
1. Use search_web with a query like "${name} ${company} linkedin" to find candidate LinkedIn profile URLs.
2. If you get one or more linkedin.com/in/ URLs, use fetch_linkedin_page on the most likely one to confirm the name, title, and company match.
3. Return a single JSON object — no markdown fences — in this exact shape:
{"profileUrl":"","name":"","title":"","company":"","confidence":0.0}

Rules:
- profileUrl must be a linkedin.com/in/ URL, or empty string if not found.
- confidence is 0.0–1.0: use 0.9 for a strong name+company match, 0.5 for a partial match, 0.0 if not found.
- If you cannot find the right profile after searching, return {"profileUrl":"","name":"${name}","title":"${title}","company":"${company}","confidence":0.0}`

  let contents: any[] = [{ role: 'user', parts: [{ text: userPrompt }] }]
  let maxTurns = 6

  while (maxTurns-- > 0) {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents,
      config: { tools: [{ functionDeclarations: LINKEDIN_TOOL_DECLARATIONS }] }
    })

    const candidate = response.candidates?.[0]
    if (!candidate?.content?.parts) break

    const parts = candidate.content.parts
    const functionCallParts = parts.filter((p: any) => p.functionCall)

    contents.push({ role: 'model', parts })

    if (functionCallParts.length === 0) {
      const text = parts.filter((p: any) => p.text).map((p: any) => p.text).join('')
      const jsonMatch = text.match(/\{[\s\S]*?\}/)
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0])
          const profileUrl = normalizeProfileUrl(String(parsed.profileUrl || ''))
          if (profileUrl && /linkedin\.com\/in\//i.test(profileUrl)) {
            return {
              profileUrl,
              name: safeText(parsed.name) || name,
              title: safeText(parsed.title) || title,
              company: safeText(parsed.company) || company,
              confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5))
            }
          }
        } catch { /* malformed JSON — fall through */ }
      }
      break
    }

    const toolResultParts: any[] = []
    for (const part of functionCallParts) {
      const fc = part.functionCall as any
      const toolName: string = fc?.name ?? ''
      const args: any = fc?.args ?? {}
      let result = 'unknown tool'
      if (toolName === 'search_web') {
        result = await toolSearchWeb(String(args?.query || ''))
      } else if (toolName === 'fetch_linkedin_page') {
        result = await toolFetchLinkedInPage(String(args?.url || ''))
      }
      toolResultParts.push({ functionResponse: { name: toolName, response: { result } } })
    }

    contents.push({ role: 'user', parts: toolResultParts })
  }

  return null
}

// -----------------------------------------------------------------------

app.post('/api/agent/search-public-profiles', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const companies = Array.isArray(body.companies) ? body.companies.map((v: any) => safeText(v)).filter(Boolean) : []
    const sectorsInput = Array.isArray(body.sectors) ? body.sectors.map((v: any) => inferSector(String(v))) : TARGET_SECTORS
    const sectors = sectorsInput.filter((v: LeadSector) => [...TARGET_SECTORS, 'unknown'].includes(v))
    const titles = Array.isArray(body.titles) ? body.titles.map((v: any) => safeText(v)).filter(Boolean) : ['CEO', 'COO', 'CRO', 'CTO']
    const limit = Math.min(Number(body.limit || 20), MAX_AGENT_RESULTS)
    const seedProfileUrls = Array.isArray(body.seedProfileUrls) ? body.seedProfileUrls.map((v: any) => normalizeProfileUrl(String(v))).filter(Boolean) : []

    if (Number.isNaN(limit) || limit <= 0) {
      return c.json(apiError('INVALID_INPUT', 'limit must be a positive number'), 400)
    }

    const queries = buildSectorCompanyQueries(companies, sectors, titles)
    const discoveredUrls = new Set<string>(seedProfileUrls.filter((url: string) => /linkedin\.com\/in\//.test(url)))

    for (const query of queries.slice(0, 20)) {
      if (discoveredUrls.size >= limit) break
      const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
      const normalizedSearchUrl = normalizeProfileUrl(searchUrl)
      if (await shouldSkipDueToCooldown(normalizedSearchUrl)) {
        await recordCrawlAttempt({ url: searchUrl, normalizedUrl: normalizedSearchUrl, query, status: 'skipped', reason: 'cooldown-window-active' })
        continue
      }

      try {
        const response = await fetch(searchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; LeadIntakeBot/1.0; +https://coresight.com)'
          }
        })

        if (!response.ok) {
          const statusType = response.status === 403 || response.status === 429 ? 'blocked' : 'failed'
          await recordCrawlAttempt({
            url: searchUrl,
            normalizedUrl: normalizedSearchUrl,
            query,
            status: statusType,
            reason: `search-http-${response.status}`,
            responseStatus: response.status
          })
          continue
        }

        const html = await response.text()
        const urls = extractLinkedinProfileUrls(html)
        for (const url of urls) {
          if (discoveredUrls.size >= limit) break
          discoveredUrls.add(url)
        }

        await recordCrawlAttempt({ url: searchUrl, normalizedUrl: normalizedSearchUrl, query, status: 'success', responseStatus: response.status })
      } catch (error: any) {
        await recordCrawlAttempt({
          url: searchUrl,
          normalizedUrl: normalizedSearchUrl,
          query,
          status: 'failed',
          reason: error?.message || 'search-fetch-failed'
        })
      }
    }

    // Secondary search engines when DuckDuckGo returns nothing
    if (discoveredUrls.size === 0) {
      for (const query of queries.slice(0, 10)) {
        if (discoveredUrls.size >= limit) break
        const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
        const normalizedBingUrl = normalizeProfileUrl(bingUrl)
        try {
          const response = await fetch(bingUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadIntakeBot/1.0; +https://coresight.com)' }
          })
          if (response.ok) {
            const html = await response.text()
            const urls = extractLinkedinProfileUrls(html)
            for (const url of urls) {
              if (discoveredUrls.size >= limit) break
              discoveredUrls.add(url)
            }
            await recordCrawlAttempt({ url: bingUrl, normalizedUrl: normalizedBingUrl, query, status: 'success', responseStatus: response.status })
          }
        } catch (error: any) {
          await recordCrawlAttempt({ url: bingUrl, normalizedUrl: normalizedBingUrl, query, status: 'failed', reason: error?.message || 'bing-fetch-failed' })
        }
      }
    }

    let usedBootstrapFallback = false
    if (discoveredUrls.size === 0 && linkedinLeads.length > 0) {
      usedBootstrapFallback = true
      for (const lead of linkedinLeads) {
        const normalized = normalizeProfileUrl(lead.profileUrl || lead.url)
        if (!normalized || !/linkedin\.com\/in\//.test(normalized)) continue
        discoveredUrls.add(normalized)
        if (discoveredUrls.size >= limit) break
      }
    }

    const candidates = Array.from(discoveredUrls).slice(0, limit).map((profileUrl) => {
      const identifier = toStableIdentifier({ profileUrl })
      return {
        identifier,
        profileUrl,
        sector: 'unknown' as LeadSector,
        isCSuite: false,
        confidence: 0,
        provenance: {
          sourceUrl: profileUrl,
          fetchedAt: new Date().toISOString(),
          method: usedBootstrapFallback ? 'bootstrap-linkedin-json' : 'public-search'
        },
        signals: { titleMatch: false, sectorMatch: false, companyMatch: false }
      }
    })

    return c.json({
      queries,
      total: candidates.length,
      usedBootstrapFallback,
      candidates
    })
  } catch (error: any) {
    return c.json(apiError('INTERNAL_ERROR', 'failed to search public profiles', error?.message), 500)
  }
})

app.post('/api/agent/extract-profile-signals', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const profiles = Array.isArray(body.profiles) ? body.profiles : []
    if (!profiles.length) {
      return c.json(apiError('INVALID_INPUT', 'profiles array is required'), 400)
    }

    const extracted: any[] = []

    for (const profile of profiles.slice(0, MAX_AGENT_RESULTS)) {
      const sourceUrl = normalizeProfileUrl(profile.profileUrl || profile.url)
      const expectedCompany = safeText(profile.company)
      const expectedSector = inferSector(profile.sector || '')

      if (!sourceUrl) {
        extracted.push({
          identifier: '',
          name: safeText(profile.name),
          title: safeText(profile.title),
          company: expectedCompany,
          sector: expectedSector,
          isCSuite: false,
          confidence: 0,
          provenance: { sourceUrl: '', fetchedAt: new Date().toISOString(), method: 'invalid-input' },
          signals: { titleMatch: false, sectorMatch: false, companyMatch: false },
          insufficientPublicData: true
        })
        continue
      }

      if (await shouldSkipDueToCooldown(sourceUrl)) {
        await recordCrawlAttempt({ url: sourceUrl, normalizedUrl: sourceUrl, status: 'skipped', reason: 'cooldown-window-active' })
      }

      let pageTitle = ''
      let metaDescription = ''
      let fetchMethod = 'public-profile-fetch'

      try {
        const response = await fetch(sourceUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; LeadIntakeBot/1.0; +https://coresight.com)'
          }
        })

        if (!response.ok) {
          const statusType = response.status === 403 || response.status === 429 ? 'blocked' : 'failed'
          await recordCrawlAttempt({
            url: sourceUrl,
            normalizedUrl: sourceUrl,
            status: statusType,
            reason: `profile-http-${response.status}`,
            responseStatus: response.status
          })
        } else {
          const html = await response.text()
          const titleMatch = html.match(/<title>(.*?)<\/title>/i)
          const descriptionMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)
          pageTitle = safeText(titleMatch?.[1] || '')
          metaDescription = safeText(descriptionMatch?.[1] || '')
          await recordCrawlAttempt({ url: sourceUrl, normalizedUrl: sourceUrl, status: 'success', responseStatus: response.status })
        }
      } catch (error: any) {
        fetchMethod = 'public-profile-fetch-failed'
        await recordCrawlAttempt({
          url: sourceUrl,
          normalizedUrl: sourceUrl,
          status: 'failed',
          reason: error?.message || 'profile-fetch-failed'
        })
      }

      const parsed = parseLinkedinTitlePage(pageTitle)
      const metaTitle = extractJobTitleFromMeta(metaDescription)

      // Prefer caller-supplied fields, then HTML extraction, then AI enrichment
      let name = safeText(profile.name) || parsed.name
      let title = safeText(profile.title) || metaTitle
      let company = expectedCompany || parsed.company

      // If we still lack a title or company, run AI extraction (costs ~1 Gemini call per profile)
      let aiResult: Awaited<ReturnType<typeof aiExtractProfileSignals>> = null
      if ((!title || !company || !name) && (pageTitle || metaDescription)) {
        aiResult = await aiExtractProfileSignals(pageTitle, metaDescription, sourceUrl)
        if (aiResult) {
          name = name || aiResult.name
          title = title || aiResult.title
          company = company || aiResult.company
        }
      }

      const sector = aiResult?.sector !== 'unknown' && aiResult?.sector
        ? aiResult.sector as LeadSector
        : inferSector(profile.sector || `${company} ${title} ${metaDescription}`)

      const titleMatch = Boolean(aiResult?.isCSuite) || isCSuiteTitle(title)
      const sectorMatch = expectedSector === 'unknown' ? sector !== 'unknown' : sector === expectedSector
      const companyMatch = expectedCompany ? company.toLowerCase().includes(expectedCompany.toLowerCase()) : !!company
      const confidence = deriveConfidence({ titleMatch, sectorMatch, companyMatch }, !!name, !!sourceUrl)

      const candidate = {
        identifier: toStableIdentifier({ profileUrl: sourceUrl, name }),
        profileUrl: sourceUrl,
        name,
        title,
        company,
        sector,
        isCSuite: titleMatch,
        confidence,
        provenance: {
          sourceUrl,
          fetchedAt: new Date().toISOString(),
          method: fetchMethod
        },
        signals: { titleMatch, sectorMatch, companyMatch },
        insufficientPublicData: confidence < AGENT_MIN_CONFIDENCE,
        raw: {
          pageTitle,
          metaDescription
        }
      }

      extracted.push(candidate)
    }

    const deduped = dedupeByIdentifier(extracted.filter(candidate => candidate.identifier))
    return c.json({ total: deduped.length, threshold: AGENT_MIN_CONFIDENCE, candidates: deduped })
  } catch (error: any) {
    return c.json(apiError('INTERNAL_ERROR', 'failed to extract profile signals', error?.message), 500)
  }
})

// Accepts an array of partially-known profiles and uses Gemini to enrich each one
// with structured data (name, title, company, sector, isCSuite) from whatever
// meta/snippet information is available. This endpoint is the "tool access" layer —
// it replaces the reliance on pre-scraped linkedin.json.
app.post('/api/agent/ai-enrich-profiles', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const profiles = Array.isArray(body.profiles) ? body.profiles : []
    if (!profiles.length) {
      return c.json(apiError('INVALID_INPUT', 'profiles array is required'), 400)
    }

    const enriched: any[] = []

    for (const profile of profiles.slice(0, MAX_AGENT_RESULTS)) {
      const pageTitle = safeText(profile.raw?.pageTitle || profile.pageTitle)
      const metaDescription = safeText(profile.raw?.metaDescription || profile.metaDescription)
      const profileUrl = normalizeProfileUrl(profile.profileUrl || profile.url || profile.identifier)

      // Fast-path: if we already have good signals, skip AI call
      const existingTitle = safeText(profile.title)
      const existingName = safeText(profile.name)
      const existingCompany = safeText(profile.company)

      let name = existingName
      let title = existingTitle || extractJobTitleFromMeta(metaDescription)
      let company = existingCompany || parseLinkedinTitlePage(pageTitle).company
      let sector = inferSector(profile.sector || `${company} ${title} ${metaDescription}`)
      let isCSuiteVal = isCSuiteTitle(title)

      // Call AI when key fields are still missing
      if (!title || !company || !name) {
        const aiResult = await aiExtractProfileSignals(pageTitle, metaDescription, profileUrl)
        if (aiResult) {
          name = name || aiResult.name
          title = title || aiResult.title
          company = company || aiResult.company
          if (aiResult.sector !== 'unknown') sector = aiResult.sector as LeadSector
          isCSuiteVal = isCSuiteVal || aiResult.isCSuite
        }
      }

      const signals = {
        titleMatch: isCSuiteVal,
        sectorMatch: TARGET_SECTORS.includes(sector),
        companyMatch: !!company,
      }
      const confidence = deriveConfidence(signals, !!name, !!profileUrl)

      enriched.push({
        ...profile,
        identifier: profileUrl || profile.identifier,
        profileUrl,
        name,
        title,
        company,
        sector,
        isCSuite: isCSuiteVal,
        confidence,
        signals,
        insufficientPublicData: confidence < AGENT_MIN_CONFIDENCE,
      })
    }

    return c.json({
      threshold: AGENT_MIN_CONFIDENCE,
      total: enriched.length,
      accepted: enriched.filter(e => !e.insufficientPublicData).length,
      candidates: enriched,
    })
  } catch (error: any) {
    return c.json(apiError('INTERNAL_ERROR', 'failed to ai-enrich profiles', error?.message), 500)
  }
})

app.post('/api/agent/rank-csuite-targets', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const candidates = Array.isArray(body.candidates) ? body.candidates : []
    const threshold = typeof body.minConfidence === 'number' ? body.minConfidence : AGENT_MIN_CONFIDENCE

    if (!candidates.length) {
      return c.json(apiError('INVALID_INPUT', 'candidates array is required'), 400)
    }

    const ranked = candidates.map((candidate: any) => {
      const confidence = Number(candidate.confidence || 0)
      const titleMatch = Boolean(candidate.signals?.titleMatch || isCSuiteTitle(candidate.title))
      const sector = inferSector(candidate.sector)
      const sectorMatch = TARGET_SECTORS.includes(sector)
      const score = Number((confidence + (titleMatch ? 0.2 : 0) + (sectorMatch ? 0.1 : 0) + (candidate.signals?.companyMatch ? 0.05 : 0)).toFixed(3))
      const accept = score >= threshold && titleMatch

      return {
        ...candidate,
        sector,
        isCSuite: titleMatch,
        score,
        accept,
        decision: accept ? 'accept' : 'insufficient_public_data'
      }
    }).sort((a: any, b: any) => b.score - a.score)

    return c.json({
      threshold,
      total: ranked.length,
      accepted: ranked.filter((item: any) => item.accept).length,
      rejected: ranked.filter((item: any) => !item.accept).length,
      candidates: ranked
    })
  } catch (error: any) {
    return c.json(apiError('INTERNAL_ERROR', 'failed to rank csuite targets', error?.message), 500)
  }
})

app.post('/api/agent/save-candidates', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const candidates = Array.isArray(body.candidates) ? body.candidates : []
    const threshold = typeof body.minConfidence === 'number' ? body.minConfidence : AGENT_MIN_CONFIDENCE

    if (!candidates.length) {
      return c.json(apiError('INVALID_INPUT', 'candidates array is required'), 400)
    }

    const accepted: any[] = []
    const rejected: any[] = []

    for (const candidate of candidates.slice(0, MAX_AGENT_RESULTS)) {
      const identifier = toStableIdentifier(candidate)
      const profileUrl = normalizeProfileUrl(candidate.profileUrl || candidate.provenance?.sourceUrl || candidate.url)
      const confidence = Number(candidate.confidence || 0)
      const sector = inferSector(candidate.sector)
      const normalizedCandidate = {
        identifier,
        profileUrl,
        name: safeText(candidate.name),
        title: safeText(candidate.title),
        company: safeText(candidate.company),
        sector,
        isCSuite: Boolean(candidate.isCSuite ?? isCSuiteTitle(candidate.title)),
        confidence,
        provenance: {
          sourceUrl: profileUrl || safeText(candidate.provenance?.sourceUrl),
          fetchedAt: candidate.provenance?.fetchedAt ? new Date(candidate.provenance.fetchedAt) : new Date(),
          method: safeText(candidate.provenance?.method) || 'agent-intake'
        },
        signals: {
          titleMatch: Boolean(candidate.signals?.titleMatch || isCSuiteTitle(candidate.title)),
          sectorMatch: Boolean(candidate.signals?.sectorMatch || TARGET_SECTORS.includes(sector)),
          companyMatch: Boolean(candidate.signals?.companyMatch || !!safeText(candidate.company))
        },
        raw: candidate.raw || null
      }

      if (!normalizedCandidate.identifier || !normalizedCandidate.provenance.sourceUrl) {
        rejected.push({ identifier: normalizedCandidate.identifier || '', reason: 'missing_identifier_or_source' })
        continue
      }

      if (normalizedCandidate.confidence < threshold) {
        rejected.push({ identifier: normalizedCandidate.identifier, reason: 'insufficient_public_data' })
        continue
      }

      if (mongoose.connection.readyState === 1) {
        await AgentLead.findOneAndUpdate(
          { identifier: normalizedCandidate.identifier },
          normalizedCandidate,
          { upsert: true, new: true }
        )
      }

      const leadShape = {
        profileUrl: normalizedCandidate.profileUrl,
        url: normalizedCandidate.profileUrl,
        name: normalizedCandidate.name,
        title: normalizedCandidate.title,
        company: normalizedCandidate.company,
        isCSuite: normalizedCandidate.isCSuite,
        contextForAI: `Signals: ${JSON.stringify(normalizedCandidate.signals)} | Provenance: ${normalizedCandidate.provenance.sourceUrl}`,
        confidence: normalizedCandidate.confidence,
        provenance: {
          sourceUrl: normalizedCandidate.provenance.sourceUrl,
          fetchedAt: normalizedCandidate.provenance.fetchedAt,
          method: normalizedCandidate.provenance.method
        }
      }

      const existingIndex = leads.findIndex(lead => getLeadIdentityKey(lead) === normalizedCandidate.identifier)
      if (existingIndex >= 0) {
        leads[existingIndex] = { ...leads[existingIndex], ...leadShape }
      } else {
        leads.push(leadShape)
      }

      accepted.push({ identifier: normalizedCandidate.identifier, confidence: normalizedCandidate.confidence })
    }

    return c.json({
      threshold,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      accepted,
      rejected,
      note: rejected.some(item => item.reason === 'insufficient_public_data') ? 'insufficient public data guardrail applied' : undefined
    })
  } catch (error: any) {
    return c.json(apiError('INTERNAL_ERROR', 'failed to save candidates', error?.message), 500)
  }
})

// --------------- HUBSPOT → LINKEDIN AGENT ---------------

// Uses Gemini with function-calling tools (search_web + fetch_linkedin_page) to
// discover LinkedIn profiles for contacts already in HubSpot. The returned
// candidates are in the standard agent format and can be piped directly to
// POST /api/agent/rank-csuite-targets and POST /api/agent/save-candidates.
app.post('/api/agent/hubspot-to-linkedin', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    // Hard cap at 25 per call to stay within Gemini rate limits (each contact = up to 6 turns)
    const limit = Math.min(Number(body.limit || 10), 25)
    // HubSpot cursor for pagination — pass the `nextCursor` from a previous response to get the next page
    const after = body.after ? String(body.after) : undefined

    if (!process.env.GEMINI_API_KEY) {
      return c.json(apiError('CONFIG_ERROR', 'GEMINI_API_KEY is not set'), 500)
    }
    if (!process.env.HUBSPOT_TOKEN) {
      return c.json(apiError('CONFIG_ERROR', 'HUBSPOT_TOKEN is not set'), 500)
    }

    // Fetch directly from HubSpot API — no in-memory cache involved
    const hsUrl = new URL('https://api.hubapi.com/crm/v3/objects/contacts')
    hsUrl.searchParams.set('limit', String(limit))
    hsUrl.searchParams.append('properties', 'firstname')
    hsUrl.searchParams.append('properties', 'lastname')
    hsUrl.searchParams.append('properties', 'email')
    hsUrl.searchParams.append('properties', 'company')
    hsUrl.searchParams.append('properties', 'jobtitle')
    hsUrl.searchParams.append('properties', 'industry')
    hsUrl.searchParams.append('properties', 'notes_last_activity_date')
    if (after) hsUrl.searchParams.set('after', after)

    const hsRes = await fetch(hsUrl.toString(), {
      headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' }
    })

    if (!hsRes.ok) {
      const errText = await hsRes.text()
      return c.json(apiError('HUBSPOT_ERROR', `HubSpot API returned ${hsRes.status}`, errText), 502)
    }

    const hsData = await hsRes.json()
    const allContacts: any[] = hsData.results || []
    const nextCursor: string | undefined = hsData.paging?.next?.after

    // Only process contacts that have enough data for a meaningful LinkedIn search
    const eligible = allContacts.filter(ct => {
      const hasName = safeText(ct.properties?.firstname) || safeText(ct.properties?.lastname)
      const hasCompany = safeText(ct.properties?.company)
      return hasName && hasCompany
    })

    if (!eligible.length) {
      return c.json({
        processed: allContacts.length,
        eligible: 0,
        found: 0,
        notFound: 0,
        nextCursor: nextCursor || null,
        note: 'No contacts on this page had both a name and company. Try nextCursor to advance to the next page.',
        candidates: []
      })
    }

    const candidates: any[] = []
    let found = 0
    let notFound = 0

    for (const contact of eligible) {
      const firstName = safeText(contact.properties?.firstname)
      const lastName = safeText(contact.properties?.lastname)
      const name = `${firstName} ${lastName}`.trim()
      const company = safeText(contact.properties?.company)
      const title = safeText(contact.properties?.jobtitle)

      try {
        const result = await findLinkedInForContact(contact)

        if (result && result.profileUrl && result.confidence >= 0.4) {
          const identifier = toStableIdentifier({ profileUrl: result.profileUrl, name: result.name })
          const sector = inferSector(`${result.company} ${result.title}`)
          const signals = {
            titleMatch: isCSuiteTitle(result.title),
            sectorMatch: TARGET_SECTORS.includes(sector as LeadSector),
            companyMatch: !!result.company
          }

          candidates.push({
            identifier,
            profileUrl: result.profileUrl,
            name: result.name || name,
            title: result.title || title,
            company: result.company || company,
            sector,
            isCSuite: signals.titleMatch,
            confidence: deriveConfidence(signals, !!result.name, true),
            provenance: {
              sourceUrl: result.profileUrl,
              fetchedAt: new Date().toISOString(),
              method: 'hubspot-to-linkedin-agent'
            },
            signals,
            hubspotId: contact.id,
            hubspotEmail: safeText(contact.properties?.email)
          })
          found++
        } else {
          notFound++
          console.log(`[hubspot-to-linkedin] No LinkedIn found for: ${name} @ ${company}`)
        }
      } catch (err: any) {
        console.error(`[hubspot-to-linkedin] Error for ${name}:`, err.message)
        notFound++
      }
    }

    return c.json({
      processed: allContacts.length,
      eligible: eligible.length,
      found,
      notFound,
      nextCursor: nextCursor || null,
      note: 'Pipe candidates into POST /api/agent/rank-csuite-targets then POST /api/agent/save-candidates. Pass nextCursor as "after" to process the next page.',
      candidates
    })
  } catch (error: any) {
    return c.json(apiError('INTERNAL_ERROR', 'failed to run hubspot-to-linkedin agent', error?.message), 500)
  }
})

// --------------- GROUPING ENDPOINTS ---------------

// Get all groups
app.get('/api/groups', async (c) => {
  try {
    const groups = await Group.find().sort({ createdAt: -1 });
    return c.json(groups);
  } catch (err: any) {
    return c.json({ error: 'Failed to fetch groups', details: err.message }, 500);
  }
});

// Create a new group
app.post('/api/groups', async (c) => {
  try {
    const body = await c.req.json();
    if (!body.name) {
      return c.json({ error: 'Group name is required' }, 400);
    }
    const newGroup = await Group.create({ name: body.name, contacts: [] });
    return c.json(newGroup, 201);
  } catch (err: any) {
    return c.json({ error: 'Failed to create group', details: err.message }, 500);
  }
});

// Add or update contacts in a group
app.put('/api/groups/:id/contacts', async (c) => {
  try {
    const groupId = c.req.param('id');
    const { contacts } = await c.req.json();
    
    if (!Array.isArray(contacts)) {
      return c.json({ error: 'Contacts must be an array' }, 400);
    }

    const group = await Group.findByIdAndUpdate(
      groupId, 
      { contacts }, // Replace the entire array with the submitted array 
      { new: true }
    );

    if (!group) return c.json({ error: 'Group not found' }, 404);
    
    return c.json(group);
  } catch (err: any) {
    return c.json({ error: 'Failed to update group contacts', details: err.message }, 500);
  }
});

// Append contacts to a group
app.post('/api/groups/:id/contacts', async (c) => {
  try {
    const groupId = c.req.param('id');
    const { contacts } = await c.req.json();
    
    if (!Array.isArray(contacts)) {
      return c.json({ error: 'Contacts must be an array' }, 400);
    }

    const group = await Group.findById(groupId);
    if (!group) return c.json({ error: 'Group not found' }, 404);

    // Append only non-existing ones
    const newContacts = contacts.filter((cc: any) => !group.contacts.some((exc: any) => exc.identifier === cc.identifier));
    group.contacts.push(...newContacts);
    await group.save();
    
    return c.json(group);
  } catch (err: any) {
    return c.json({ error: 'Failed to add contacts to group', details: err.message }, 500);
  }
});

// Remove a contact from a group
app.delete('/api/groups/:id/contacts/:identifier', async (c) => {
  try {
    const groupId = c.req.param('id');
    const identifier = decodeURIComponent(c.req.param('identifier'));

    const group = await Group.findById(groupId);
    if (!group) return c.json({ error: 'Group not found' }, 404);

    group.contacts = group.contacts.filter((contact: any) => contact.identifier !== identifier);
    await group.save();

    return c.json(group);
  } catch (err: any) {
    return c.json({ error: 'Failed to remove contact from group', details: err.message }, 500);
  }
});

app.get('/', (c) => {
  return c.text('Email Lead Generation API is running!')
})

// Endpoint to get all leads
app.get('/api/leads', (c) => {
  const search = c.req.query('search');
  let result = leads;
  
  if (search) {
    const s = search.toLowerCase();
    result = leads.filter(l => 
      (l.name && l.name.toLowerCase().includes(s)) ||
      (l.title && l.title.toLowerCase().includes(s)) ||
      (l.company && l.company.toLowerCase().includes(s)) ||
      (l.email && l.email.toLowerCase().includes(s))
    );
  }
  
  return c.json(result)
})

// Endpoint to get hubspot contacts with pagination
app.get('/api/hubspot/contacts', async (c) => {
  const limitStr = c.req.query('limit') || '50'
  const offsetStr = c.req.query('offset') || '0'
  const search = c.req.query('search')
  
  const limit = parseInt(limitStr, 10)
  const offset = parseInt(offsetStr, 10)
  
  if (isNaN(limit) || isNaN(offset)) {
    return c.json({ error: 'invalid limit or offset parameters' }, 400)
  }
  
  if (!search) {
    await ensureHubspotContacts(offset + limit)
  }
  
  let filteredContacts = hubspotContacts;
  if (search) {
    const s = search.toLowerCase();
    filteredContacts = hubspotContacts.filter(contact => {
      const fn = contact.properties?.firstname?.toLowerCase() || '';
      const ln = contact.properties?.lastname?.toLowerCase() || '';
      const em = contact.properties?.email?.toLowerCase() || '';
      const comp = contact.properties?.company?.toLowerCase() || '';
      return fn.includes(s) || ln.includes(s) || em.includes(s) || comp.includes(s);
    });
  }
  
  const paginatedContacts = filteredContacts.slice(offset, offset + limit)
  return c.json({
    total: filteredContacts.length,
    limit,
    offset,
    results: paginatedContacts
  })
})

// Endpoint to get a selected number of hubspot contacts (e.g. 50, 100, 500, 1000)
app.get('/api/hubspot/contacts/:count', async (c) => {
  const countStr = c.req.param('count')
  const count = parseInt(countStr, 10)
  
  if (isNaN(count)) {
    return c.json({ error: 'invalid count parameter' }, 400)
  }
  
  const offsetStr = c.req.query('offset') || '0'
  const offset = parseInt(offsetStr, 10) || 0
  const search = c.req.query('search')
  
  if (!search) {
    await ensureHubspotContacts(offset + count)
  }
  
  let filteredContacts = hubspotContacts;
  if (search) {
    const s = search.toLowerCase();
    filteredContacts = hubspotContacts.filter(contact => {
      const fn = contact.properties?.firstname?.toLowerCase() || '';
      const ln = contact.properties?.lastname?.toLowerCase() || '';
      const em = contact.properties?.email?.toLowerCase() || '';
      const comp = contact.properties?.company?.toLowerCase() || '';
      return fn.includes(s) || ln.includes(s) || em.includes(s) || comp.includes(s);
    });
  }
  
  const paginatedContacts = filteredContacts.slice(offset, offset + count)
  return c.json({
    total: filteredContacts.length,
    limit: count,
    offset,
    results: paginatedContacts
  })
})

// Endpoint to search HubSpot contacts directly via HubSpot API
app.on(['GET', 'POST'], '/api/hubspot/search', async (c) => {
  try {
    let body: any = {};
    if (c.req.method === 'POST') {
      try {
        body = await c.req.json();
      } catch (e) {
        // ignore JSON parse error
      }
    }
    
    // Support both body and query params
    const company = body.company || c.req.query('company');
    const role = body.role || c.req.query('role');
    const region = body.region || c.req.query('region');
    const interactedParam = body.interacted ?? c.req.query('interacted');
    let interacted: boolean | undefined = undefined;
    if (interactedParam === true || interactedParam === 'true') {
      interacted = true;
    } else if (interactedParam === false || interactedParam === 'false') {
      interacted = false;
    }
    const limit = parseInt(body.limit || c.req.query('limit') || '50', 10);
    const after = body.after || c.req.query('after');

    const ht = process.env.HUBSPOT_TOKEN;
    if (!ht) {
      return c.json({ error: 'HUBSPOT_TOKEN is not set.' }, 500);
    }

    const filters: any[] = [];
    
    if (company) {
      filters.push({ propertyName: 'company', operator: 'CONTAINS_TOKEN', value: company });
    }
    if (role) {
      filters.push({ propertyName: 'jobtitle', operator: 'CONTAINS_TOKEN', value: role });
    }
    if (interacted === true) {
      filters.push({ propertyName: 'hs_email_last_open_date', operator: 'HAS_PROPERTY' });
    } else if (interacted === false) {
      filters.push({ propertyName: 'hs_email_last_open_date', operator: 'NOT_HAS_PROPERTY' });
    }
    
    let filterGroups: any[] = [];
    
    // If region is specified, we check state, city, or country using OR logic (multiple filter groups)
    if (region) {
      filterGroups = [
        { filters: [...filters, { propertyName: 'state', operator: 'CONTAINS_TOKEN', value: region }] },
        { filters: [...filters, { propertyName: 'city', operator: 'CONTAINS_TOKEN', value: region }] },
        { filters: [...filters, { propertyName: 'country', operator: 'CONTAINS_TOKEN', value: region }] }
      ];
    } else if (filters.length > 0) {
      // Just apply standard AND filters
      filterGroups = [{ filters }];
    }

    const searchBody: any = {
      limit: limit,
      // Request standard properties to return
      properties: ["firstname", "lastname", "email", "company", "jobtitle", "state", "city", "country", "hs_email_last_open_date", "hs_email_last_click_date", "industry", "notes_last_activity_date"]
    };

    if (filterGroups.length > 0) {
      searchBody.filterGroups = filterGroups;
    }
    if (after) {
      searchBody.after = after;
    }

    const response = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST", // The HubSpot CRM Search API requires a POST request always
      headers: {
        Authorization: `Bearer ${ht}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(searchBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("HubSpot Search API Error:", response.status, errText);
      return c.json({ error: 'HubSpot API error', details: errText }, response.status as any);
    }

    const data = await response.json();
    return c.json(data);
  } catch (error: any) {
    console.error('Error in /api/hubspot/search:', error);
    return c.json({ error: 'Failed to search Hubspot contacts', details: error.message }, 500);
  }
})

async function generateEmailForLead(identifier: string, company?: string, context?: string) {
  const normalizedIdentifier = normalizeProfileUrl(identifier) || identifier.toLowerCase().trim()

  if (mongoose.connection.readyState === 1) {
    const persistedAgentLead = await AgentLead.findOne({
      $or: [
        { identifier: normalizedIdentifier },
        { profileUrl: normalizedIdentifier },
        { 'provenance.sourceUrl': normalizedIdentifier },
        { name: identifier }
      ]
    }).lean()

    if (persistedAgentLead) {
      if (persistedAgentLead.confidence < AGENT_MIN_CONFIDENCE) {
        throw new Error('Insufficient public data for this lead. Confidence below threshold; not eligible for email generation.')
      }

      const enrichedCompany = company || persistedAgentLead.company
      const aiContext = `Validated candidate from public web. Confidence: ${persistedAgentLead.confidence}. Signals: ${JSON.stringify(persistedAgentLead.signals)}. Provenance: ${persistedAgentLead.provenance?.sourceUrl}`
      const prompt = `
You are an expert sales development representative (SDR) working for Coresight Research (coresight.com). 
Coresight Research delivers data-driven insights focusing on retail and technology, helping businesses navigate disruption reshaping global retail through proprietary intelligence and a global community of industry leaders.

Generate a highly personalized cold outreach email for the following validated lead data.

Your goal is to write a cold email that sounds natural, professional, and aims to start a conversation. 
Do NOT sound like a generic AI or use placeholders (like [Your Name]).

Lead Details:
Name: ${persistedAgentLead.name || 'Unknown'}
Title: ${persistedAgentLead.title || 'Unknown'}
Company: ${enrichedCompany || 'Unknown'}
Sector: ${persistedAgentLead.sector || 'unknown'}

Additional Lead Context from AI/Scraping:
${aiContext}

User Instructions/Context:
${context || 'None'}
      `.trim()

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      })

      return { text: response.text, leadName: persistedAgentLead.name }
    }
  }

  // Find the lead in regular leads first
  let lead = leads.find(l => 
    l.email === identifier || 
    l.profileUrl === identifier || 
    l.url === identifier ||
    l.name === identifier
  )
  
  if (lead && company) {
    // Override or populate with the explicitly provided company
    lead.company = company;
  }
  
  let isHubspotContact = false;

  // If not found in leads, search in HubSpot contacts
  if (!lead) {
    let hsContact = hubspotContacts.find(c => 
      c.properties?.email === identifier ||
      c.id === identifier ||
      `${c.properties?.firstname || ''} ${c.properties?.lastname || ''}`.trim() === identifier
    )
    
    // If contact was not found locally (maybe found via HubSpot search endpoint instead), fetch it from HubSpot API
    if (!hsContact && process.env.HUBSPOT_TOKEN) {
      const ht = process.env.HUBSPOT_TOKEN;
      const isEmail = identifier.includes('@');
      
      try {
        const idProp = isEmail ? '&idProperty=email' : '';
        const res = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(identifier)}?properties=firstname,lastname,email,company,jobtitle,hs_email_last_open_date,hs_email_last_click_date,industry,notes_last_activity_date${idProp}`, {
          headers: { Authorization: `Bearer ${ht}` }
        });
        if (res.ok) {
          hsContact = await res.json();
        }
      } catch(e) { console.error("Error fetching contact by ID/Email", e); }
      
      // If still not found and it's not an email, try using the Search API globally
      if (!hsContact && !isEmail) {
        try {
          const searchBody = {
            query: identifier, // Generic search across text/name fields
            limit: 1,
            properties: ["firstname", "lastname", "email", "company", "jobtitle", "hs_email_last_open_date", "hs_email_last_click_date", "industry", "notes_last_activity_date"]
          };
          const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
            method: "POST",
            headers: { Authorization: `Bearer ${ht}`, "Content-Type": "application/json" },
            body: JSON.stringify(searchBody)
          });
          if (res.ok) {
            const data = await res.json();
            if (data.results && data.results.length > 0) {
              hsContact = data.results[0];
            }
          }
        } catch(e) { console.error("Error searching contact by name", e); }
      }

      // Cache the dynamically fetched contact for later use
      if (hsContact) {
        const exists = hubspotContacts.find(c => c.id === hsContact.id);
        if (!exists) {
          hubspotContacts.push(hsContact);
        }
      }
    }
    
    if (hsContact) {
      isHubspotContact = true;
      lead = {
        name: `${hsContact.properties?.firstname || ''} ${hsContact.properties?.lastname || ''}`.trim(),
        email: hsContact.properties?.email,
        company: company || hsContact.properties?.company || 'Unknown', // HubSpot might not have company in base properties unless requested, and explicit input takes precedence
        title: hsContact.properties?.jobtitle || 'Unknown',
        contextForAI: 'This contact was imported from HubSpot. We have limited context about them.',
        about: 'N/A'
      }
    }
  }

  if (!lead) {
    throw new Error('Lead/Contact not found. Please provide a valid email, profileUrl, url, or name as identifier.');
  }

  const aiContext = lead.contextForAI || ''
  
  // Adjust prompt based on whether it's a rich lead or a basic HubSpot contact
  const contextInstruction = isHubspotContact 
    ? `This is a contact imported from our CRM (HubSpot). We have limited context about them. Rely more on generic professional outreach best practices and the User Instructions provided below, while keeping it personalized to their name, title, and company if available.`
    : `Generate a highly personalized cold outreach email for the following lead based on their detailed profile data and context.`;

  const prompt = `
You are an expert sales development representative (SDR) working for Coresight Research (coresight.com). 
Coresight Research delivers data-driven insights focusing on retail and technology, helping businesses navigate disruption reshaping global retail through proprietary intelligence and a global community of industry leaders.

${contextInstruction}

Your goal is to write a cold email that sounds natural, professional, and aims to start a conversation. 
Do NOT sound like a generic AI or use placeholders (like [Your Name]). 

Use the following real example as a benchmark for style, tone, and structure:

--- EXAMPLE EMAIL ---
Subject: Quick question, [Lead Name]

Hi [Lead Name],

Hope you're having a good week.

My name is [Your Name], and I'm an SDR at Coresight Research. We work with professionals focused on enhancing operational efficiency and improving critical workflows across various departments.

I don't have much context on your current priorities, but I was curious if finding new ways to streamline processes or gain deeper insights into business performance is an area you're exploring right now?

If not, no problem at all. If it is, I'd be happy to briefly share how others are approaching it.

Best regards,

[Your Name]
Sales Development Representative
Coresight Research
www.coresight.com
--- END EXAMPLE ---

Adapt the messaging of the example to fit the specific Lead Details and User Instructions below, but maintain the concise, low-pressure approach. Incorporate Coresight's unique value props (retail & tech data-driven insights) subtly if it makes sense for the lead's industry, otherwise stick to general business performance/efficiency.

Lead Details:
Name: ${lead.name || 'Unknown'}
Title: ${lead.title || 'Unknown'}
Company: ${lead.company || 'Unknown'}
About: ${lead.about || 'N/A'}

Additional Lead Context from AI/Scraping:
${aiContext}

User Instructions/Context:
${context || 'None'}
  `.trim()

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  })

  return { text: response.text, leadName: lead.name };
}

// Endpoint to generate personalized email
app.post('/api/generate-email', async (c) => {
  try {
    const { identifier, context, company } = await c.req.json();
    const result = await generateEmailForLead(identifier, company, context);

    return c.json({ 
      success: true,
      text: result.text,
      leadName: result.leadName
    });
  } catch (error: any) {
    console.error("Error generating email:", error);
    return c.json({ error: error.message || 'Failed to generate email' }, 500);
  }
});

// Endpoint to bulk generate emails for a group
app.post('/api/bulk-generate-email', async (c) => {
  try {
    const body = await c.req.json();
    const { groupId, identifiers, context } = body;
    let targets: { identifier: string; name?: string; company?: string }[] = [];

    if (groupId) {
      const group = await Group.findById(groupId);
      if (!group) return c.json({ error: 'Group not found' }, 404);
      targets = group.contacts.map((contact: any) => ({ identifier: contact.identifier, name: contact.name, company: contact.company }));
    } else if (Array.isArray(identifiers)) {
      targets = identifiers.map(id => typeof id === 'string' ? { identifier: id } : id);
    } else {
      return c.json({ error: 'Must provide groupId or an array of identifiers' }, 400);
    }

    // 1. Ask Gemini to generate a single master template for the entire group
    const prompt = `
You are an expert sales development representative (SDR) working for Coresight Research (coresight.com). 
Coresight Research delivers data-driven insights focusing on retail and technology, helping businesses navigate disruption reshaping global retail through proprietary intelligence and a global community of industry leaders.

You are writing a SINGLE bulk outreach email campaign template that will be sent to a specific group of targeted professionals.

User Instructions / Campaign Topic Context:
${context || 'General introduction to Coresight Research and an offer to share retail/tech insights.'}

Your goal is to write a natural, professional cold email template aiming to start a conversation. 

CRITICAL: You MUST use exactly these literal variables where appropriate so our system can automatically replace them:
Wait, use these EXACT strings:
- {{Name}} for the recipient's first name or full name
- {{Company}} for the recipient's company

Do NOT sound like a generic AI or use placeholders (like [Your Name]). 
Sign off naturally as an SDR from Coresight Research (e.g. "Sales Development Representative / Coresight Research").
Keep the tone concise and low-pressure.

Format:
Subject: [Your suggested subject line]

Hi {{Name}},

[Body containing {{Company}} if it makes sense]
...
    `.trim();

    const aiRes = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    const templateText = aiRes.text || "Subject: Hello from Coresight\n\nHi {{Name}},\n\nI hope you are having a great week at {{Company}}.\n\nBest,\nSales Development Representative\nCoresight Research";

    // 2. Hydrate the template locally for each targeted user to avoid LLM rate limits
    const generated = await Promise.all(targets.map(async (t) => {
      let leadName = t.name;
      let leadCompany = t.company;

      if (!leadName || !leadCompany) {
        // Try to pull data from locally stored leads
        const l = leads.find(lead => lead.email === t.identifier || lead.profileUrl === t.identifier || lead.name === t.identifier || lead.url === t.identifier);
        if (l) {
          leadName = leadName || l.name;
          leadCompany = leadCompany || l.company;
        } else {
          // Try to pull data from locally stored HubSpot cache
          const hs = hubspotContacts.find(c => c.id === t.identifier || (c.properties && c.properties.email === t.identifier));
          if (hs && hs.properties) {
             leadName = leadName || `${hs.properties.firstname || ''} ${hs.properties.lastname || ''}`.trim();
             leadCompany = leadCompany || hs.properties.company;
          }
        }
      }

      // Fallbacks if data is truly blank
      const safeName = leadName || 'there'; 
      const safeCompany = leadCompany || 'your company';

      // Perform replacement
      let customText = templateText
        .replace(/\{\{Name\}\}/ig, safeName)
        .replace(/\{\{Company\}\}/ig, safeCompany);

      return {
        identifier: t.identifier,
        success: true,
        text: customText,
        leadName: safeName
      };
    }));

    return c.json({ results: generated });
  } catch (err: any) {
    console.error('Error in bulk generate:', err);
    return c.json({ error: 'Bulk generation failed', details: err.message }, 500);
  }
});

// Nodemailer transporter (Gmail)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER || 'elijahandrew1610@gmail.com',
    pass: process.env.SMTP_PASS || '',
  },
});

// Endpoint to send an email
app.post('/api/send-email', async (c) => {
  try {
    const body = await c.req.json();
    const { to, subject, text } = body;

    if (!to || !subject || !text) {
      return c.json({ error: 'Missing required fields: to, subject, text' }, 400);
    }

    const info = await transporter.sendMail({
      from: process.env.SMTP_USER || 'elijahandrew1610@gmail.com',
      to,
      subject,
      text,
    });

    return c.json({
      success: true,
      messageId: info.messageId,
    });
  } catch (error: any) {
    console.error('Error sending email:', error);
    return c.json({ error: 'Failed to send email', details: error.message }, 500);
  }
});

// Endpoint to send bulk emails concurrently
app.post('/api/bulk-send-email', async (c) => {
  try {
    const { emails } = await c.req.json();
    
    if (!Array.isArray(emails)) {
      return c.json({ error: 'Missing required field: emails array' }, 400);
    }

    // Process sends concurrently via Promise.allSettled
    const results = await Promise.allSettled(
      emails.map(email => transporter.sendMail({
        from: process.env.SMTP_USER || 'elijahandrew1610@gmail.com',
        to: email.to,
        subject: email.subject,
        text: email.text,
      }))
    );

    const sent = results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return { to: emails[index].to, success: true, messageId: result.value.messageId };
      } else {
        return { to: emails[index].to, success: false, error: result.reason?.message };
      }
    });

    return c.json({ results: sent });
  } catch (error: any) {
    console.error('Error in bulk send:', error);
    return c.json({ error: 'Failed to send bulk emails', details: error.message }, 500);
  }
});

serve({
  fetch: app.fetch,
  port: 5000
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})
