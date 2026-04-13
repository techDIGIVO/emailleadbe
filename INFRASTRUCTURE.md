# Backend Infrastructure & Architecture Documentation

This document outlines the fundamental architecture, technology stack, external integrations, and API design of the Email Lead Generation Backend. It serves as an infrastructure reference separate from the frontend integration documentation.

## 1. Core Technology Stack

- **Runtime Environment:** Node.js (with `tsx` for local dev watch execution)
- **Language:** TypeScript
- **Web Framework:** [Hono](https://hono.dev/) via `@hono/node-server` (chosen for lightweight, blazing-fast standard Request/Response routing)
- **Package Manager:** npm

## 2. Key Libraries & Modules

- **`@google/genai`**: Official Google Gemini SDK for AI content and email generation.
- **`nodemailer`**: Used for SMTP email dispatching and delivery.
- **`dotenv`**: Manages operational environment variables securely from the `.env` file.
- **`hono/cors`**: Cross-Origin Resource Sharing middleware facilitating direct frontend-to-backend communication.

## 3. External Integrations & APIs

The backend orchestrates multiple external services to handle lead aggregation, AI generation, and outreach:

### 3.1 HubSpot CRM API
- **Endpoint Used:** `https://api.hubapi.com/crm/v3/objects/contacts`
- **Authentication:** Bearer Token via the `HUBSPOT_TOKEN` environment variable.
- **Purpose:** To enrich the platform's lead pool with existing CRM contacts.
- **Mechanism:** Implements an intelligent memory-based auto-fetch module. The server initially loads contacts from a local `hubspot.json` cache into RAM. If the frontend requests a pagination range (`offset + limit`) that exceeds the loaded amount, the backend iteratively polls the HubSpot API to retrieve novel pages and appending them dynamically, skipping duplicates by ID.

### 3.2 Google Gemini AI API
- **Model:** `gemini-2.5-flash`
- **Authentication:** API Key via the `GEMINI_API_KEY` environment variable.
- **Purpose:** Generates highly personalized cold outreach emails. By passing in extracted lead parameters (Name, Title, Company, About) coupled with user instructions and system prompts (acting as a Coresight Research SDR), the model tailors standard outreach templates to specific individuals.

### 3.3 SMTP Email Provider (Gmail)
- **Protocol:** SMTP via `smtp.gmail.com` (Port 465, Secure)
- **Authentication:** Regulated by `SMTP_USER` and `SMTP_PASS` (usually a Google App Password).
- **Purpose:** Dispenses the final AI-generated emails securely to the target prospects.

## 4. Internal API Endpoints

The Hono server exposes the following RESTful endpoints to coordinate with the frontend application:

### Health & Config
- **`GET /`**: Server healthcheck endpoint.

### Data Aggregation
- **`GET /api/leads`**: Returns merged static leads with `linkedin.json` loaded first, then non-duplicate records from `leads.json`.
- **`GET /api/hubspot/contacts`**: Returns paginated HubSpot contacts (queries: `limit`, `offset`). Triggers the HubSpot API bridge if the requested offset requires more data than what currently exists in memory.
- **`GET /api/hubspot/contacts/:count`**: Returns a designated count of contacts. Allows an `offset` query to bypass the first `n` contacts while supporting the auto-fetch bridge.

### Agentic Lead Intake (Public-Page Only)
- **`POST /api/agent/search-public-profiles`**: Builds sector/company-first public queries and discovers candidate profile URLs.
- **`POST /api/agent/extract-profile-signals`**: Fetches public pages and extracts canonical lead fields, provenance, confidence, and ranking signals.
- **`POST /api/agent/rank-csuite-targets`**: Scores candidates for C-suite targeting quality.
- **`POST /api/agent/save-candidates`**: Persists only candidates above confidence threshold (guardrail applied).

Operational characteristics:
- Anonymous collection is best-effort and can be blocked (403/429) unpredictably.
- Crawl attempts are persisted (success/failed/blocked/skipped) to enforce cooldown and avoid repeated dead-end fetches.
- `src/linkedin.json` is used as bootstrap fallback, not primary source.

Lead normalization details:
- LinkedIn records are normalized at load time so `companyName` is mapped into `company`.
- `companyWebsite` is preserved on each lead object for LinkedIn-related processing.
- If the same lead exists in both files, the `linkedin.json` version takes precedence.
- Identity matching continues to support `email`, `profileUrl`, `url`, and `name`.

### Processing & Action
- **`POST /api/generate-email`**: 
  - **Payload:** `{ identifier: string, context: string }`
  - **Action:** Looks up validated persisted agentic candidates first. If confidence is below threshold, generation is blocked. Otherwise falls back to local leads and then HubSpot contacts. Constructs the master prompt injecting the lead details and requests execution from the Gemini model.
  - **Returns:** `{ success: boolean, text: string, leadName: string }`
- **`POST /api/send-email`**: 
  - **Payload:** `{ to: string, subject: string, text: string }`
  - **Action:** Transmits the payload directly through the `nodemailer` SMTP transport.
  - **Returns:** `{ success: boolean, messageId: string }`

## 5. Security & Environment Keys

To protect sensitive keys from source control, and to allow straightforward staging, the service depends on `.env`. The following key-value pairs are necessary:

- `GEMINI_API_KEY`: Grants access to Google AI models.
- `HUBSPOT_TOKEN`: HubSpot Private App Token for CRM scope operations.
- `SMTP_USER`: Sender email address.
- `SMTP_PASS`: App-specific configuration password allowing Node to mail on behalf of the user.
