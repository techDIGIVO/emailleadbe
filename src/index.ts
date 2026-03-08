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

app.get('/', (c) => {
  return c.text('Email Lead Generation API is running!')
})

// Endpoint to get all leads
app.get('/api/leads', (c) => {
  return c.json(leads)
})

// Endpoint to get hubspot contacts with pagination
app.get('/api/hubspot/contacts', (c) => {
  const limitStr = c.req.query('limit') || '50'
  const offsetStr = c.req.query('offset') || '0'
  
  const limit = parseInt(limitStr, 10)
  const offset = parseInt(offsetStr, 10)
  
  if (isNaN(limit) || isNaN(offset)) {
    return c.json({ error: 'invalid limit or offset parameters' }, 400)
  }
  
  const paginatedContacts = hubspotContacts.slice(offset, offset + limit)
  return c.json({
    total: hubspotContacts.length,
    limit,
    offset,
    results: paginatedContacts
  })
})

// Endpoint to get a selected number of hubspot contacts (e.g. 50, 100, 500, 1000)
app.get('/api/hubspot/contacts/:count', (c) => {
  const countStr = c.req.param('count')
  const count = parseInt(countStr, 10)
  
  if (isNaN(count)) {
    return c.json({ error: 'invalid count parameter' }, 400)
  }
  
  const offsetStr = c.req.query('offset') || '0'
  const offset = parseInt(offsetStr, 10) || 0
  
  const paginatedContacts = hubspotContacts.slice(offset, offset + count)
  return c.json({
    total: hubspotContacts.length,
    limit: count,
    offset,
    results: paginatedContacts
  })
})
// Endpoint to generate personalized email
app.post('/api/generate-email', async (c) => {
  try {
    const body = await c.req.json()
    const { identifier, context } = body
    
    // Find the lead in regular leads first
    let lead = leads.find(l => 
      l.email === identifier || 
      l.profileUrl === identifier || 
      l.url === identifier ||
      l.name === identifier
    )
    
    let isHubspotContact = false;

    // If not found in leads, search in HubSpot contacts
    if (!lead) {
      const hsContact = hubspotContacts.find(c => 
        c.properties?.email === identifier ||
        c.id === identifier ||
        `${c.properties?.firstname || ''} ${c.properties?.lastname || ''}`.trim() === identifier
      )
      
      if (hsContact) {
        isHubspotContact = true;
        lead = {
          name: `${hsContact.properties?.firstname || ''} ${hsContact.properties?.lastname || ''}`.trim(),
          email: hsContact.properties?.email,
          company: hsContact.properties?.company || 'Unknown', // HubSpot might not have company in base properties, but we set a default
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
