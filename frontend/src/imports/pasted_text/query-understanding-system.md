Create an improved Ask AI interaction system for a sales call intelligence dashboard.

The current issue is that the AI agent treats every user prompt as a keyword search across transcripts.
Instead, the system should understand the user's intent and conversation context before retrieving data.

Design the UI and interaction flow for a Query Understanding system that sits between the user input and transcript retrieval.

Core Product Feature

Add a Query Interpreter Layer to the Ask AI system.

New flow:

User Question
↓
Query Interpreter (understands intent)
↓
Structured Query
↓
Transcript Retrieval
↓
Conversational AI Response

Query Intent Types

The interpreter should classify user prompts into these categories:

SEARCH_QUERY
User is asking to find mentions of a topic.

Example:
"List meetings where Europe functionality was discussed."

COUNT_QUERY

Example:
"How many calls mentioned pricing?"

TREND_ANALYSIS

Example:
"What were the most discussed topics in the last 5 calls?"

FOLLOW_UP

User refers to a previous answer.

Example:
"Can you recheck the evidence?"
"Show those snippets again."

For FOLLOW_UP queries, the system should NOT perform a new transcript search.
It should re-evaluate the previously retrieved results.

CORRECTION

Example:
"I think that count is wrong."
"Check the last 5 calls again."

The system should rerun the previous query with updated filters.

DRILL_DOWN

Example:
"Show the full conversation from that meeting."

UI Behavior

Add a small system layer in the Ask AI interface showing:

AI Understanding

Example:

Intent: Trend Analysis
Topic: Product Capabilities
Scope: Last 7 Calls

This can appear as a subtle UI label above the answer.

Conversational Response Style

The AI responses should feel like a sales analyst explaining findings, not a database output.

Example structure:

Insight Summary

Pricing came up quite frequently across recent calls.

Supporting Evidence

Acme Demo — Mar 10
"...can you walk us through the pricing tiers..."

Fintech Discovery — Mar 9
"...pricing flexibility will be important for us..."

Follow-up Suggestion

Would you like me to show which clients asked about pricing most often?