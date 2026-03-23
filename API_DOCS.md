# Email Lead Generation API — Documentation

> **Base URL:** `http://localhost:5000`

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
| `location`      | `string?` | Geographic location                                        |
| `about`         | `string?` | Bio / about section                                        |
| `experience`    | `string?` | Work experience text                                       |
| `contextForAI`  | `string`  | Scraped LinkedIn profile context used for email generation |
| `isCSuite`      | `boolean` | Whether the lead is a C-suite executive                    |
| `searchKeyword` | `string?` | The keyword used to find this lead                         |

> **Note:** Some leads use `url` while others use `profileUrl` for the LinkedIn link. The API handles both when looking up a lead.

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
| `limit` | `number` | Number of results to return (default: `50`) |
| `after` | `string` | Pagination cursor returned from a previous search |

#### Example Search Request Body
```json
{
  "company": "Coresight",
  "role": "Manager",
  "region": "California"
}
```
*Alternatively, you can provide the parameters in the URL:*
`/api/hubspot/search?company=Coresight&role=Manager&region=California`

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
        "country": "United States"
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
