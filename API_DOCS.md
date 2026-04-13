# Email Lead Generation API — Documentation

> **Base URL:** `http://localhost:5000`

---

## Agent Pipeline (recommended flow)

Two entry points depending on your data source:

**Starting from HubSpot contacts (new):**
```
1. POST /api/agent/hubspot-to-linkedin      → Gemini finds LinkedIn profile for each HubSpot contact
2. POST /api/agent/rank-csuite-targets      → score & filter to C-suite leads
3. POST /api/agent/save-candidates          → persist accepted leads
```

**Starting from public search (original):**
```
1. POST /api/agent/search-public-profiles   → discover LinkedIn profile URLs
2. POST /api/agent/extract-profile-signals  → fetch & parse each profile (HTML + AI)
3. POST /api/agent/ai-enrich-profiles       → AI re-enrichment for any still-incomplete profiles
4. POST /api/agent/rank-csuite-targets      → score & filter to C-suite leads
5. POST /api/agent/save-candidates          → persist accepted leads
```

Steps 2 and 3 of the public search flow are complementary — run 3 on the output of 2 for any candidates still flagged `insufficientPublicData`.

---

## Endpoints

### 1. Health Check

|              |                                                     |
| ------------ | --------------------------------------------------- |
| **Method**   | `GET`                                               |
| **URL**      | `/`                                                 |
| **Response** | Plain text: `Email Lead Generation API is running!` |

---

### 2. Get All Leads

|              |                                            |
| ------------ | ------------------------------------------ |
| **Method**   | `GET`                                      |
| **URL**      | `/api/leads`                               |
| **Response** | `application/json` — Array of lead objects |

#### Response Example

```json
[
  {
    "url": "https://www.linkedin.com/in/williamhgates/",
    "email": "bill@example.com",
    "type": "linkedin",
    "name": "Bill Gates",
    "title": "Chair, Gates Foundation and Founder, Breakthrough Energy",
    "contextForAI": "...",
    "isCSuite": true
  },
  {
    "profileUrl": "https://www.linkedin.com/in/some-profile",
    "name": "Jane Doe",
    "title": "CEO at SomeCompany",
    "location": "London, United Kingdom",
    "company": "SomeCompany",
    "companyName": "SomeCompany",
    "companyWebsite": "https://somecompany.com",
    "about": "",
    "experience": "...",
    "isCSuite": true,
    "contextForAI": "...",
    "searchKeyword": "CEO"
  }
]
```

#### Lead Object Fields

| Field           | Type      | Description                                                |
| --------------- | --------- | ---------------------------------------------------------- |
| `url`           | `string?` | LinkedIn profile URL (older format leads)                  |
| `profileUrl`    | `string?` | LinkedIn profile URL (newer format leads)                  |
| `email`         | `string?` | Contact email (not always present)                         |
| `name`          | `string`  | Full name of the lead                                      |
| `title`         | `string`  | Job title                                                  |
| `company`       | `string?` | Company name                                               |
| `companyName`   | `string?` | Company name from LinkedIn source data                     |
| `companyWebsite`| `string?` | Company website from LinkedIn source data                  |
| `location`      | `string?` | Geographic location                                        |
| `about`         | `string?` | Bio / about section                                        |
| `experience`    | `string?` | Work experience text                                       |
| `contextForAI`  | `string`  | Scraped LinkedIn profile context used for email generation |
| `isCSuite`      | `boolean` | Whether the lead is a C-suite executive                    |
| `searchKeyword` | `string?` | The keyword used to find this lead                         |

> **Note:** LinkedIn-related workflows now use a hybrid intake path (public search/fetch + dedupe + persistence). `src/linkedin.json` is retained as a bootstrap fallback source when anonymous public collection is blocked.

---

### 3. Generate Personalized Email

|                  |                       |
| ---------------- | --------------------- |
| **Method**       | `POST`                |
| **URL**          | `/api/generate-email` |
| **Content-Type** | `application/json`    |

#### Request Body

```json
{
  "identifier": "Bill Gates",
  "company": "Microsoft",
  "context": "We are selling an AI-powered CRM tool for enterprise companies."
}
```

| Field        | Type     | Required | Description                                                                                                                             |
| ------------ | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `identifier` | `string` | ✅ Yes   | Used to find the lead. Can be: **name**, **email**, **url**, or **profileUrl**                                                          |
| `company`    | `string` | ❌ No    | Explicitly provide the company name, taking precedence over default scraped or CRM data                                                 |
| `context`    | `string` | ❌ No    | Additional instructions or context for the AI to tailor the email (e.g. what product you're selling, the tone, specific talking points) |

#### Success Response — `200`

```json
{
  "success": true,
  "text": "Subject: Transforming Enterprise CRM with AI\n\nHi Bill,\n\nI hope this message finds you well...",
  "leadName": "Bill Gates"
}
```

| Field      | Type      | Description                                                       |
| ---------- | --------- | ----------------------------------------------------------------- |
| `success`  | `boolean` | Always `true` on success                                          |
| `text`     | `string`  | The generated email in **plain text** (ready to display directly) |
| `leadName` | `string`  | Name of the matched lead                                          |

#### Error Response — `404` (Lead Not Found)

```json
{
  "error": "Lead not found. Please provide a valid email, profileUrl, url, or name as identifier."
}
```

#### Error Response — `500` (Generation Failed)

```json
{
  "error": "Failed to generate email"
}
```

---

### 4. Send Email

|                  |                    |
| ---------------- | ------------------ |
| **Method**       | `POST`             |
| **URL**          | `/api/send-email`  |
| **Content-Type** | `application/json` |

#### Request Body

```json
{
  "to": "recipient@example.com",
  "subject": "Let's Connect — AI-Powered CRM for Enterprise",
  "text": "Hi Bill,\n\nI hope this message finds you well..."
}
```

| Field     | Type     | Required | Description                                                       |
| --------- | -------- | -------- | ----------------------------------------------------------------- |
| `to`      | `string` | ✅ Yes   | Recipient email address                                           |
| `subject` | `string` | ✅ Yes   | Email subject line                                                |
| `text`    | `string` | ✅ Yes   | Plain text email body (use the `text` from `/api/generate-email`) |

#### Success Response — `200`

```json
{
  "success": true,
  "messageId": "<abc123@smtp.office365.com>"
}
```

#### Error Response — `400` (Missing Fields)

```json
{
  "error": "Missing required fields: to, subject, text"
}
```

#### Error Response — `500` (Send Failed)

```json
{
  "error": "Failed to send email",
  "details": "Invalid login: 535 5.7.3 Authentication unsuccessful"
}
```

---

### 5. Search HubSpot Contacts Directly

|                  |                    |
| ---------------- | ------------------ |
| **Method**       | `POST` or `GET`    |
| **URL**          | `/api/hubspot/search` |
| **Content-Type** | `application/json` (if POST) |

#### Query Parameters or Request Body

| Field | Type | Description |
| --- | --- | --- |
| `company` | `string` | Filter by company name |
| `role` | `string` | Filter by job title |
| `region` | `string` | Filter by state, city, or country |
| `interacted` | `boolean` | If `true`, returns contacts that have opened an email. If `false`, returns contacts that have NOT opened an email. |
| `limit` | `number` | Number of results to return (default: `50`) |
| `after` | `string` | Pagination cursor returned from a previous search |

#### Example Search Request Body
```json
{
  "company": "Coresight",
  "role": "Manager",
  "region": "California",
  "interacted": true
}
```
*Alternatively, you can provide the parameters in the URL:*
`/api/hubspot/search?company=Coresight&role=Manager&region=California&interacted=true`

#### Success Response
```json
{
  "total": 15,
  "results": [
    {
      "id": "12345",
      "properties": {
        "firstname": "John",
        "lastname": "Doe",
        "company": "Coresight",
        "jobtitle": "Marketing Manager",
        "state": "California",
        "city": "Los Angeles",
        "country": "United States",
        "industry": "Retail",
        "hs_email_last_open_date": "2024-05-12T08:32:00Z",
        "hs_email_last_click_date": "2024-05-13T10:00:00Z",
        "notes_last_activity_date": "2024-06-01T00:00:00Z"
      }
    }
  ],
  "paging": {
    "next": {
      "after": "100"
    }
  }
}
```

| Property | Description |
| --- | --- |
| `industry` | Industry as set in HubSpot (e.g. `"Retail"`, `"Real Estate"`). `null` if not set. |
| `notes_last_activity_date` | Date of the contact's last recorded activity in HubSpot. `null` if blank. |
| `hs_email_last_open_date` | Last date the contact opened an email sent via HubSpot. |
| `hs_email_last_click_date` | Last date the contact clicked a link in a HubSpot email. |
```

---

## 6. Agentic LinkedIn Lead Intake (Phase 1 MVP)

All endpoints below are best-effort public-page collection only (no login required, no paid fallback source).

### 6.0 HubSpot → LinkedIn Agent (Gemini-powered)
**POST** `/api/agent/hubspot-to-linkedin`

Uses Gemini AI with function-calling tools to find the LinkedIn profile for each contact already in HubSpot. Gemini is given two tools it can call autonomously:
- `search_web` — searches DuckDuckGo (Bing fallback) and returns any `linkedin.com/in/` URLs found
- `fetch_linkedin_page` — fetches a LinkedIn profile page to confirm name/title/company match

Returns candidates in the **standard agent format**, ready to pipe directly into `POST /api/agent/rank-csuite-targets` and `POST /api/agent/save-candidates`.

> **Note:** Only contacts that have both a name and a company are eligible (required for a meaningful search). Cap `limit` at 25 per call to stay within Gemini rate limits.

Fetches contacts **directly from the HubSpot API** on every call (no in-memory cache). Supports cursor-based pagination via `nextCursor`.

#### Request Body

```json
{
  "limit": 10,
  "after": "optional-cursor-from-previous-response"
}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | `number` | `10` | How many HubSpot contacts to fetch and process per call. Max `25`. |
| `after` | `string` | — | Pagination cursor. Pass the `nextCursor` value from a previous response to get the next page. |

#### Success Response

```json
{
  "processed": 10,
  "eligible": 8,
  "found": 6,
  "notFound": 2,
  "nextCursor": "AoJ...",
  "note": "Pipe candidates into POST /api/agent/rank-csuite-targets then POST /api/agent/save-candidates. Pass nextCursor as 'after' to process the next page.",
  "candidates": [
    {
      "identifier": "https://linkedin.com/in/jane-doe",
      "profileUrl": "https://linkedin.com/in/jane-doe",
      "name": "Jane Doe",
      "title": "Chief Operating Officer",
      "company": "Acme Corp",
      "sector": "retail",
      "isCSuite": true,
      "confidence": 0.8,
      "provenance": {
        "sourceUrl": "https://linkedin.com/in/jane-doe",
        "fetchedAt": "2026-04-13T00:00:00.000Z",
        "method": "hubspot-to-linkedin-agent"
      },
      "signals": {
        "titleMatch": true,
        "sectorMatch": true,
        "companyMatch": true
      },
      "hubspotId": "12345",
      "hubspotEmail": "jane@acmecorp.com"
    }
  ]
}
```

| Field | Description |
| --- | --- |
| `processed` | Total contacts fetched from HubSpot on this call |
| `eligible` | Contacts that had both a name and company (required for LinkedIn search) |
| `found` | Contacts for which a LinkedIn profile was found |
| `notFound` | Contacts where Gemini could not find a confident match |
| `nextCursor` | Pass as `after` in the next request to get the next page. `null` means no more pages. |
```

#### Recommended flow

```
1. POST /api/agent/hubspot-to-linkedin       → discover LinkedIn profiles for HubSpot contacts
2. POST /api/agent/rank-csuite-targets       → score & filter to C-suite leads
3. POST /api/agent/save-candidates           → persist accepted leads
```

---

### 6.1 Search Public Profiles
**POST** `/api/agent/search-public-profiles`

Builds company/sector-first public queries and returns candidate profile URLs with provenance.

```json
{
  "companies": ["Target", "Shopify"],
  "sectors": ["retail", "commerce"],
  "titles": ["CEO", "COO", "CTO"],
  "limit": 20,
  "seedProfileUrls": ["https://www.linkedin.com/in/example/"]
}
```

### 6.2 Extract Profile Signals
**POST** `/api/agent/extract-profile-signals`

Fetches public profile pages, extracts signals, and returns canonical candidates with confidence + provenance.

```json
{
  "profiles": [
    {
      "profileUrl": "https://www.linkedin.com/in/example/",
      "company": "Target",
      "sector": "retail"
    }
  ]
}
```

### 6.3 Rank C-Suite Targets
**POST** `/api/agent/rank-csuite-targets`

Ranks candidates and marks each as `accept` or `insufficient_public_data`.

```json
{
  "minConfidence": 0.65,
  "candidates": []
}
```

### 6.4 Save Candidates
**POST** `/api/agent/save-candidates`

Persists only candidates above confidence threshold and rejects low-evidence records.

```json
{
  "minConfidence": 0.65,
  "candidates": []
}
```

### Canonical Candidate Contract

```json
{
  "identifier": "https://linkedin.com/in/example",
  "name": "Jane Doe",
  "title": "Chief Operating Officer",
  "company": "Example Co",
  "sector": "retail",
  "isCSuite": true,
  "confidence": 0.82,
  "provenance": {
    "sourceUrl": "https://www.linkedin.com/in/example/",
    "fetchedAt": "2026-04-12T00:00:00.000Z",
    "method": "public-profile-fetch"
  },
  "signals": {
    "titleMatch": true,
    "sectorMatch": true,
    "companyMatch": true
  }
}
```

`POST /api/generate-email` now enforces a confidence guardrail for persisted agentic candidates and blocks generation when confidence is below threshold.

---

## 7. Group Management and Bulk Actions

### 7.1 Get All Groups
**GET** `/api/groups`
Returns an array of all saved groups.

### 7.2 Create a Group
**POST** `/api/groups`
```json
{
  "name": "Q3 CEO Campaign"
}
```

### 7.3 Update Contacts in a Group
**PUT** `/api/groups/:id/contacts`
Replace the entire list of contacts in a group.
```json
{
  "contacts": [
    { "identifier": "bill@example.com", "leadSource": "linkedin", "name": "Bill Gates" },
    { "identifier": "51", "leadSource": "hubspot" }
  ]
}
```

### 7.4 Add Contacts to a Group (Append)
**POST** `/api/groups/:id/contacts`
Appends new contacts to an existing group without deleting the old ones.
```json
{
  "contacts": [
    { "identifier": "newuser@example.com", "leadSource": "linkedin", "name": "New User" }
  ]
}
```

### 7.5 Remove a Contact from a Group
**DELETE** `/api/groups/:id/contacts/:identifier`
Removes a specific contact from the group by their exact `identifier`. (For emails and URLs, ensure the parameter is URL-encoded).

### 7.6 Generate Bulk Emails
**POST** `/api/bulk-generate-email`
Generates a unique, high-quality email template specifically for your provided `context` (the campaign topic). The backend automatically handles replacing `{{Name}}` and `{{Company}}` locally for everyone in the group, ensuring you never hit AI rate limits.

You can supply a `groupId` to target a saved group, or an array of raw `identifiers`.

**Request Body:**
```json
{
  "groupId": "64abcdef1234567890abcdef",
  "context": "We just published a new research brief on AI in retail. Ask if they are exploring this topic."
}
```

| Field | Type | Description |
| --- | --- | --- |
| `groupId` | `string` | The ID of the saved group. |
| `identifiers` | `array` | Optional alternative: Array of strings (HubSpot IDs/emails) to target directly instead of a `groupId`. |
| `context` | `string` | The campaign topic/instructions. The AI uses this exactly to craft the specific master group template! |

**Returns:**
```json
{
  "results": [
    { "identifier": "51", "success": true, "text": "Subject: ...", "leadName": "John" }
  ]
}
```

### 7.7 Send Bulk Emails
**POST** `/api/bulk-send-email`
Pass an array of emails to logically send them all concurrently.
```json
{
  "emails": [
    { "to": "test@example.com", "subject": "Hello", "text": "Hi there..." }
  ]
}
```

---

## Frontend Integration Examples

### Fetch All Leads

```javascript
const response = await fetch("http://localhost:5000/api/leads");
const leads = await response.json();
// leads is an array of lead objects
```

### Generate Email for a Lead

```javascript
const response = await fetch("http://localhost:5000/api/generate-email", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    identifier: "Bill Gates", // or use profileUrl / email
    context: "Pitch our AI analytics platform for nonprofits",
  }),
});

const data = await response.json();

if (data.success) {
  // data.text contains the plain text email — render directly
  console.log(data.text);
} else {
  console.error(data.error);
}
```

### Send an Email

```javascript
const response = await fetch("http://localhost:5000/api/send-email", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    to: "recipient@example.com",
    subject: "Let's Connect",
    text: generatedEmailText, // plain text from /api/generate-email
  }),
});

const data = await response.json();

if (data.success) {
  console.log("Sent! Message ID:", data.messageId);
} else {
  console.error(data.error, data.details);
}
```

---

## CORS

CORS is enabled for all origins (`*`), so the frontend can call the API from any domain during development.

---

## Environment Variables

| Variable         | Description                                                  |
| ---------------- | ------------------------------------------------------------ |
| `GEMINI_API_KEY` | Your Google Gemini API key (required for email generation)   |
| `SMTP_USER`      | SMTP sender email (defaults to `elijahandrew1610@gmail.com`) |
| `SMTP_PASS`      | SMTP password / app password for Gmail                       |

### Running the Server

```bash
# Development (with hot reload)
GEMINI_API_KEY="your-key" npm run dev

# Production
npm run build
GEMINI_API_KEY="your-key" npm start
```
