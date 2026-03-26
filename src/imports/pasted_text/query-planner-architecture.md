Current flow:

User Prompt
   ↓
Extract all words
   ↓
Search transcripts for every word
   ↓
Return matches

Example:

User prompt:

"Can you recheck the evidences you shared?"

Your system searches transcripts for:

recheck
evidences
shared

Which makes no sense, because this is a follow-up instruction, not a search query.

2. Correct Architecture (Two-Agent System)

You need a Query Planner Agent before the retrieval step.

Correct flow:

User Prompt
   ↓
Query Planner
   ↓
Determine Intent
   ↓
Retrieve relevant data
   ↓
Answer Generator
3. Query Intent Types

Your planner should classify the prompt into one of these:

Intent	Example
Search	"Where was pricing discussed?"
Count	"How many calls mentioned Europe?"
Trend analysis	"Top topics in last 5 calls"
Follow-up / clarification	"Can you recheck the evidence?"
Drill-down	"Show the transcript snippet"
Re-analysis	"Check the last 3 calls again"

Follow-up prompts should not trigger a new keyword search.

4. Query Planner Prompt

Add this system prompt for the query planner agent.

You are a query planning agent for a sales call intelligence platform.

Your task is to understand the user's intent before retrieving data.

Do NOT treat every word in the prompt as a search keyword.

Instead classify the prompt into one of these intents:

1. SEARCH_QUERY
User is asking to find mentions of a topic or keyword.

Example:
"Which meetings discussed pricing?"

2. COUNT_QUERY
User wants totals or frequency.

Example:
"How many times was Europe mentioned?"

3. TREND_QUERY
User wants patterns or top topics.

Example:
"What were the most discussed capabilities in the last 10 calls?"

4. FOLLOW_UP
User is referring to a previous answer.

Example:
"Can you recheck the evidence?"
"Show the snippets again."
"Explain that more."

For FOLLOW_UP queries:
Do NOT run a new transcript search.
Instead refer to the previous answer and re-evaluate the evidence.

5. DRILL_DOWN
User wants deeper detail.

Example:
"Show the full conversation from that meeting."

6. CORRECTION
User is questioning the accuracy.

Example:
"I think that count is wrong."
"Recheck the calls."

For CORRECTION:
Re-run retrieval using the previous query topic.

Return the intent classification and extraction of the core topic.
5. Topic Extraction (Critical)

Only extract core search concepts, not every word.

Example:

User query:

List meetings where Europe functionality was discussed

Topic extracted:

Europe functionality

NOT:

list
meetings
where
was
discussed
6. Example Behavior After Fix
User Prompt

List meetings where Europe functionality was discussed

Planner:

Intent: SEARCH_QUERY
Topic: Europe functionality

Search transcripts for:

Europe
EU
European region
data residency
Follow-Up Prompt

User:

Can you recheck the evidence?

Planner:

Intent: FOLLOW_UP

Action:

Revalidate previously retrieved transcript snippets

NO new search.

Correction Prompt

User:

That doesn't look right. Check the last 5 calls again.

Planner:

Intent: CORRECTION
Topic: previous query topic
Filter: last 5 calls
7. Stopword Filtering (Simple Fix)

Add a stopword filter before keyword extraction.

Ignore words like:

recheck
show
explain
tell
can
you
please
again

Only keep domain words like:

pricing
Europe
expense
integration
capability
8. Add Conversation Memory

Store:

last_query_topic
last_retrieved_calls
last_answer

Example:

Topic: Europe functionality
Calls: 5
Mentions: 12

Follow-up queries should reference this memory.

9. Better Retrieval Prompt

Your retrieval agent should get structured instructions like:

Topic: Europe functionality
Intent: SEARCH_QUERY
Date Range: last 7 days

NOT raw user prompts.

10. Expected Behavior

After this fix:

User:

List meetings where Europe functionality was discussed

Agent:

Search transcripts for Europe-related discussions

User:

Recheck the evidence

Agent:

Re-evaluate the retrieved snippets

User:

Show only the last 5 calls

Agent:

Apply new filter, same topic