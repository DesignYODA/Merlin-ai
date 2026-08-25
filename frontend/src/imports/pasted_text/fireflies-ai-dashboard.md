Here’s a **strong prompt you can give to Cursor, Claude, Lovable, v0, or any AI UI builder** to generate the **dashboard + backend architecture** for your Fireflies call-analysis agent.

---

## Prompt

**Build a modern AI-powered dashboard that analyzes call recordings from Fireflies and allows users to query insights using natural language (similar to ChatGPT).**

### Product Overview

Create a SaaS-style dashboard where the system continuously analyzes call recordings from **Fireflies.ai** and stores structured insights. Users can ask questions in natural language about conversations across all meetings, and the AI agent retrieves accurate answers from the analyzed transcripts.

Example query from a user:

> “How many times was *Canada* mentioned in meetings in the last 7 days?”

The system should return:

* Total number of mentions
* List of meetings where it appeared
* Call title
* Account Executive (AE)
* Meeting date
* Snippet of conversation where it was mentioned

---

# 1. Frontend Requirements

### UI Style

* **Clean AI-native interface**
* Inspired by **ChatGPT + Linear + Notion dashboards**
* Dark mode default
* Modern SaaS layout

### Layout Structure

**Sidebar**

* Dashboard
* Ask AI
* Calls Library
* Insights
* Topics / Keywords
* Settings

---

### Main Page: "Ask AI About Calls"

Create a **GPT-like chat interface** where users can ask questions.

Elements:

* Search / question input field
* Chat history
* AI response cards
* Structured results tables

Example result card:

**Query:**
“How many times was Canada mentioned in the last 7 days?”

**AI Output**

* Mentions: 12
* Meetings: 5

Table:

| Call Title        | AE         | Date   | Mention Context                          |
| ----------------- | ---------- | ------ | ---------------------------------------- |
| Acme Demo         | Sarah Lee  | Mar 10 | "...expansion plans in Canada..."        |
| Fintech Discovery | Rahul Shah | Mar 9  | "...Canadian compliance requirements..." |

Allow:

* Export to CSV
* Copy results
* Filter by date / AE

---

# 2. Calls Library Page

Show analyzed meetings.

Columns:

* Call title
* Client name
* AE
* Date
* Duration
* Topics discussed
* Sentiment
* Key product requests

Clicking a call opens:

* Transcript
* AI summary
* Topics extracted
* Feature requests mentioned
* Competitors mentioned

---

# 3. Backend AI Agent System

Create a **multi-agent architecture** that processes Fireflies calls.

### Agent 1 — Call Ingestion Agent

* Pull recordings and transcripts from Fireflies API
* Run automatically every few hours
* Store:

  * call title
  * participants
  * AE
  * date
  * transcript
  * recording link

---

### Agent 2 — Conversation Analysis Agent

Process transcripts using LLM.

Extract:

* Topics discussed
* Countries mentioned
* Feature requests
* Competitors mentioned
* Objections
* Customer sentiment
* Key questions asked

Store results in structured database.

---

### Agent 3 — Knowledge Indexing Agent

Create embeddings of:

* transcript chunks
* extracted topics
* entities

Store in a **vector database** for semantic search.

Use:

* Pinecone / Weaviate / Supabase Vector
* OpenAI embeddings

---

### Agent 4 — Query Intelligence Agent

When user asks a question:

1. Parse intent
2. Convert question to:

   * semantic search
   * structured query
3. Retrieve relevant transcript chunks
4. Run reasoning
5. Generate structured answer

Example workflow:

User Query
“How many times was Canada mentioned in last 7 days?”

Steps:

* Detect entity: Canada
* Detect time filter: last 7 days
* Search transcripts
* Count mentions
* Return meeting metadata

---

# 4. Database Schema

Tables:

**calls**

* id
* title
* ae_name
* date
* duration
* transcript
* recording_url

**mentions**

* call_id
* entity
* mention_text
* timestamp

**topics**

* call_id
* topic
* confidence_score

**feature_requests**

* call_id
* product_feature
* client_name
* snippet

---

# 5. AI Features

Add advanced insights:

Auto-generated insights:

* Top topics this week
* Countries most mentioned
* Feature requests from customers
* Objections raised by prospects

---

# 6. Example Queries the AI Should Handle

Users can ask:

* "How many times was Canada mentioned last week?"
* "Which clients asked about integrations?"
* "Which meetings mentioned pricing concerns?"
* "Which prospects requested mobile features?"
* "What objections came up in the last 10 demos?"

---

# 7. Tech Stack

Frontend:

* Next.js
* Tailwind
* ShadCN components

Backend:

* Python or Node
* LangChain / LlamaIndex

AI:

* OpenAI / Claude

Database:

* Postgres
* Vector DB (Pinecone or Supabase)

Integrations:

* Fireflies API

---

# 8. Extra Feature (Important)

Add **Product Feedback Intelligence**

Automatically detect moments when the AE says things like:

* “We don’t have that feature yet”
* “That’s not supported currently”
* “I’ll check with product”
* “That’s on the roadmap”

Store these in a **Product Request Dashboard** with:

* client name
* feature requested
* call link
* AE

---

# 9. Design Requirements

Design should look like:

* **modern AI workspace**
* minimal
* data rich
* fast navigation
* enterprise SaaS feel

Add:

* charts
* conversation highlights
* clickable insights

---

💡 **Pro tip for your hackathon:**
This idea is extremely strong because it becomes **"Gong + Productboard + ChatGPT for calls."**

If you want, I can also give you:

* **a 10x better hackathon version of this idea**
* **agent architecture diagram**
* **the exact prompt to generate the UI in v0 or Lovable**
* **a killer name for this product** (which could win demos).
