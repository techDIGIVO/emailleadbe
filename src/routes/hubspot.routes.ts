import { Hono } from 'hono'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ensureHubspotContacts, getHubspotContacts, setHubspotContacts } from '../services/hubspot.service.js'

// ---- Load HubSpot contacts bootstrap file ----

const hubspotPath = join(process.cwd(), 'src', 'hubspot.json')
let hubspotContactsLoaded = false

function ensureBootstrap() {
  if (hubspotContactsLoaded) return
  try {
    const data = readFileSync(hubspotPath, 'utf8')
    const parsed = JSON.parse(data)
    const contacts = parsed.results || []
    setHubspotContacts(contacts)
    console.log(`Loaded ${contacts.length} HubSpot contacts`)
  } catch (e) {
    console.error("Error loading hubspot.json:", e)
  }
  hubspotContactsLoaded = true
}

// ---- Routes ----

const hubspotRoutes = new Hono()

// Paginated contacts
hubspotRoutes.get('/api/hubspot/contacts', async (c) => {
  ensureBootstrap()
  const limitStr = c.req.query('limit') || '50'
  const offsetStr = c.req.query('offset') || '0'
  const search = c.req.query('search')

  const limit = parseInt(limitStr, 10)
  const offset = parseInt(offsetStr, 10)

  if (isNaN(limit) || isNaN(offset)) {
    return c.json({ error: 'invalid limit or offset parameters' }, 400)
  }

  const hubspotContacts = getHubspotContacts()

  if (!search) {
    await ensureHubspotContacts(offset + limit)
  }

  let filteredContacts = getHubspotContacts()
  if (search) {
    const s = search.toLowerCase()
    filteredContacts = filteredContacts.filter((contact: any) => {
      const fn = contact.properties?.firstname?.toLowerCase() || ''
      const ln = contact.properties?.lastname?.toLowerCase() || ''
      const em = contact.properties?.email?.toLowerCase() || ''
      const comp = contact.properties?.company?.toLowerCase() || ''
      return fn.includes(s) || ln.includes(s) || em.includes(s) || comp.includes(s)
    })
  }

  const paginatedContacts = filteredContacts.slice(offset, offset + limit)
  return c.json({
    total: filteredContacts.length,
    limit,
    offset,
    results: paginatedContacts
  })
})

// Get N contacts
hubspotRoutes.get('/api/hubspot/contacts/:count', async (c) => {
  ensureBootstrap()
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

  let filteredContacts = getHubspotContacts()
  if (search) {
    const s = search.toLowerCase()
    filteredContacts = filteredContacts.filter((contact: any) => {
      const fn = contact.properties?.firstname?.toLowerCase() || ''
      const ln = contact.properties?.lastname?.toLowerCase() || ''
      const em = contact.properties?.email?.toLowerCase() || ''
      const comp = contact.properties?.company?.toLowerCase() || ''
      return fn.includes(s) || ln.includes(s) || em.includes(s) || comp.includes(s)
    })
  }

  const paginatedContacts = filteredContacts.slice(offset, offset + count)
  return c.json({
    total: filteredContacts.length,
    limit: count,
    offset,
    results: paginatedContacts
  })
})

// HubSpot search
hubspotRoutes.on(['GET', 'POST'], '/api/hubspot/search', async (c) => {
  try {
    let body: any = {}
    if (c.req.method === 'POST') {
      try { body = await c.req.json() } catch { /* ignore */ }
    }

    const company = body.company || c.req.query('company')
    const role = body.role || c.req.query('role')
    const region = body.region || c.req.query('region')
    const interactedParam = body.interacted ?? c.req.query('interacted')
    let interacted: boolean | undefined = undefined
    if (interactedParam === true || interactedParam === 'true') interacted = true
    else if (interactedParam === false || interactedParam === 'false') interacted = false
    const limit = parseInt(body.limit || c.req.query('limit') || '50', 10)
    const after = body.after || c.req.query('after')

    const ht = process.env.HUBSPOT_TOKEN
    if (!ht) {
      return c.json({ error: 'HUBSPOT_TOKEN is not set.' }, 500)
    }

    const filters: any[] = []
    if (company) filters.push({ propertyName: 'company', operator: 'CONTAINS_TOKEN', value: company })
    if (role) filters.push({ propertyName: 'jobtitle', operator: 'CONTAINS_TOKEN', value: role })
    if (interacted === true) filters.push({ propertyName: 'hs_email_last_open_date', operator: 'HAS_PROPERTY' })
    else if (interacted === false) filters.push({ propertyName: 'hs_email_last_open_date', operator: 'NOT_HAS_PROPERTY' })

    let filterGroups: any[] = []
    if (region) {
      filterGroups = [
        { filters: [...filters, { propertyName: 'state', operator: 'CONTAINS_TOKEN', value: region }] },
        { filters: [...filters, { propertyName: 'city', operator: 'CONTAINS_TOKEN', value: region }] },
        { filters: [...filters, { propertyName: 'country', operator: 'CONTAINS_TOKEN', value: region }] },
      ]
    } else if (filters.length > 0) {
      filterGroups = [{ filters }]
    }

    const searchBody: any = {
      limit,
      properties: ["firstname", "lastname", "email", "company", "jobtitle", "state", "city", "country", "hs_email_last_open_date", "hs_email_last_click_date", "industry", "notes_last_activity_date"]
    }
    if (filterGroups.length > 0) searchBody.filterGroups = filterGroups
    if (after) searchBody.after = after

    const response = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ht}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(searchBody)
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error("HubSpot Search API Error:", response.status, errText)
      return c.json({ error: 'HubSpot API error', details: errText }, response.status as any)
    }

    const data = await response.json()
    return c.json(data)
  } catch (error: any) {
    console.error('Error in /api/hubspot/search:', error)
    return c.json({ error: 'Failed to search Hubspot contacts', details: error.message }, 500)
  }
})

// Diagnostic: fetch HubSpot property definitions for our filter fields
hubspotRoutes.get('/api/hubspot/diagnostics/properties', async (c) => {
  const ht = process.env.HUBSPOT_TOKEN
  if (!ht) return c.json({ error: 'HUBSPOT_TOKEN is not set' }, 500)

  const propsToCheck = [
    'company', 'jobtitle', 'industry', 'hs_lead_status',
    'notes_last_activity_date', 'hs_email_last_open_date',
    'state', 'city', 'country',
  ]

  const results: Record<string, any> = {}

  for (const prop of propsToCheck) {
    try {
      const res = await fetch(`https://api.hubapi.com/crm/v3/properties/contacts/${prop}`, {
        headers: { Authorization: `Bearer ${ht}` }
      })
      if (res.ok) {
        const data = await res.json()
        results[prop] = {
          name: data.name,
          label: data.label,
          type: data.type,
          fieldType: data.fieldType,
          hasUniqueValue: data.hasUniqueValue,
          searchableInGlobalSearch: data.searchableInGlobalSearch,
          options: data.options?.slice(0, 10), // first 10 enum options if any
        }
      } else {
        results[prop] = { error: `${res.status} — property may not exist` }
      }
    } catch (err: any) {
      results[prop] = { error: err.message }
    }
  }

  return c.json(results)
})

// Diagnostic: sample actual contact data from HubSpot API to see real values
hubspotRoutes.get('/api/hubspot/diagnostics/sample', async (c) => {
  const ht = process.env.HUBSPOT_TOKEN
  if (!ht) return c.json({ error: 'HUBSPOT_TOKEN is not set' }, 500)

  const props = [
    'firstname', 'lastname', 'company', 'jobtitle', 'industry',
    'state', 'city', 'country', 'hs_lead_status', 'lastmodifieddate',
  ]

  const url = new URL('https://api.hubapi.com/crm/v3/objects/contacts')
  url.searchParams.set('limit', '20')
  for (const p of props) url.searchParams.append('properties', p)

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${ht}` }
  })

  if (!res.ok) {
    const errText = await res.text()
    return c.json({ error: `HubSpot API ${res.status}`, details: errText }, 500)
  }

  const data = await res.json()
  const sample = (data.results || []).map((contact: any) => ({
    id: contact.id,
    firstname: contact.properties?.firstname,
    lastname: contact.properties?.lastname,
    company: contact.properties?.company,
    jobtitle: contact.properties?.jobtitle,
    industry: contact.properties?.industry,
    state: contact.properties?.state,
    city: contact.properties?.city,
    country: contact.properties?.country,
    hs_lead_status: contact.properties?.hs_lead_status,
    lastmodifieddate: contact.properties?.lastmodifieddate,
  }))

  return c.json({ sampleSize: sample.length, sample })
})

export { ensureBootstrap }
export default hubspotRoutes
