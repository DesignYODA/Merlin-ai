Prompt to Fix Ask AI About Calls (Hallucination + 50 Call Limit)

You are improving an AI-powered dashboard that analyzes Fireflies call recordings and allows users to ask natural language questions about conversations.

Currently the system has two critical issues:

The Ask AI module hallucinates answers or only looks at call titles instead of transcripts.

The backend is only analyzing ~50 calls, while the system must analyze and index ALL calls from Fireflies.

Your task is to fix the architecture and prompting so answers are grounded in transcripts and all calls are analyzed.

Problem 1: AI Hallucinating / Only Using Call Titles
Root Cause

The system is likely:

Searching metadata instead of transcript embeddings

Not retrieving transcript chunks

Allowing the LLM to generate answers without grounding

Fix Requirements

Implement Retrieval Augmented Generation (RAG) using transcript chunks.

Correct Query Pipeline

When a user asks a question:

Example:

"How many times was Canada mentioned in meetings in the last 7 days?"

The system must follow this pipeline:

Parse the user query

detect entity: "Canada"

detect time filter: "last 7 days"

Search transcript embeddings

retrieve relevant transcript chunks

DO NOT search only titles or metadata

Filter by metadata

meeting date

participants

AE

call ID

Count actual occurrences in transcripts

Return structured grounded results

Strict Grounding Rule

The LLM must only answer using retrieved transcript data.

If no transcript evidence exists:

Return:

"No mentions of 'Canada' were found in the analyzed call transcripts in the last 7 days."

Never infer or hallucinate.

Prompt Template for the AI Query Agent

Use the following system prompt for the answering agent:

You are an AI assistant that answers questions about sales calls.

You MUST only answer using retrieved transcript evidence.

Rules:
1. Only use transcript chunks provided in the context.
2. Never infer information from call titles alone.
3. Never fabricate meeting details.
4. If evidence is missing, say the data was not found.

When counting mentions:
- Look for exact entity mentions in transcript text
- Aggregate by call ID
- Return structured output

Output format:

Total Mentions: X
Total Meetings: X

Meetings:
- Call Title
- AE
- Date
- Transcript snippet where the entity appears
Problem 2: Only 50 Calls Being Analyzed
Root Cause

Likely causes:

Fireflies API pagination not handled

ingestion limit

batch processing capped

missing background worker

Fix: Full Call Ingestion Pipeline
Implement Proper Pagination

Fireflies API returns calls in pages.

The ingestion agent must:

while(has_more_calls):
    fetch_next_page()
    process_calls()

Never stop at the first 50.

Backend Call Processing Architecture

Create a background ingestion worker.

Pipeline:

1️⃣ Fetch all calls from Fireflies

Store:

call_id

title

date

participants

AE

transcript

recording link

2️⃣ Chunk transcripts

Split transcripts into:

500–800 token chunks
with overlap

Example:

chunk_1
chunk_2
chunk_3

3️⃣ Create embeddings

Store embeddings for each chunk.

Vector DB schema:

chunk_id
call_id
call_title
ae_name
date
transcript_chunk
embedding

4️⃣ Index ALL calls

Do not limit.

Process until:

total_calls_indexed = total_calls_in_fireflies
Add Automatic Sync Job

Schedule a background job:

every 1 hour

Steps:

check Fireflies for new calls

process only new calls

add embeddings

update index

Required System Improvements

Implement:

1. Vector Search

Use:

Pinecone

Weaviate

Supabase Vector

pgvector

Search transcript chunks, not titles.

2. Hybrid Search

Combine:

vector search
+
keyword match

Example:

Search keyword:

Canada

Then confirm in transcript chunks.

3. Metadata Filtering

Allow filtering by:

date range

AE

company

call type

Example Correct Output

User Query:

"How many times was Canada mentioned in meetings in the last 7 days?"

Correct response:

Total Mentions: 12
Total Meetings: 5

Meetings:

1. Call: Acme Demo
   AE: Sarah Lee
   Date: Mar 10
   Snippet:
   "...we are planning expansion in Canada next quarter..."

2. Call: Fintech Discovery
   AE: Rahul Shah
   Date: Mar 9
   Snippet:
   "...Canadian compliance requirements are important..."
Important Guardrails

AI must:

❌ NOT guess answers
❌ NOT rely on titles
❌ NOT summarize without evidence

AI must:

✅ quote transcript snippets
✅ count real mentions
✅ link results to calls

Additional Feature (Optional but Recommended)

Pre-index entities automatically during ingestion.

Extract:

countries

competitors

product features

pricing mentions

objections

Store in database.

This will make queries 10x faster.