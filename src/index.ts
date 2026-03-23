import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { GoogleGenAI } from '@google/genai'
import { readFileSync } from 'fs'
import { join } from 'path'
import 'dotenv/config';
import nodemailer from 'nodemailer';

const app = new Hono()

app.use('/*', cors())

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

// Load leads
const leadsPath = join(process.cwd(), 'src', 'leads.json')
let leads: any[] = []
try {
  const data = readFileSync(leadsPath, 'utf8')
  leads = JSON.parse(data)
} catch (e) {
  console.error("Error loading leads.json:", e)
}

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
      properties: ["firstname", "lastname", "email", "company", "jobtitle", "state", "city", "country", "hs_email_last_open_date", "hs_email_last_click_date"]
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

// Endpoint to generate personalized email
app.post('/api/generate-email', async (c) => {
  try {
    const body = await c.req.json()
    const { identifier, context, company } = body
    
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
          const res = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(identifier)}?properties=firstname,lastname,email,company,jobtitle,hs_email_last_open_date,hs_email_last_click_date${idProp}`, {
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
              properties: ["firstname", "lastname", "email", "company", "jobtitle", "hs_email_last_open_date", "hs_email_last_click_date"]
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
      return c.json({ error: 'Lead/Contact not found. Please provide a valid email, profileUrl, url, or name as identifier.' }, 404)
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

    const emailContent = response.text

    // Return plain text as well for proper displays
    return c.json({ 
      success: true,
      text: emailContent,
      leadName: lead.name
    })

  } catch (error) {
    console.error("Error generating email:", error)
    return c.json({ error: 'Failed to generate email' }, 500)
  }
})

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

serve({
  fetch: app.fetch,
  port: 5000
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})
