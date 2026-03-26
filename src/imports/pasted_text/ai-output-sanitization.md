CRITICAL OUTPUT RULES:

1. Never include HTML tags in responses.
2. Never include CSS classes such as:
   class=, text-white, text-gray, span, div, style.
3. Do not output <span>, <div>, or any HTML formatting.
4. Use only clean Markdown or plain text formatting.

Allowed formatting:
- bullet lists
- numbered lists
- tables
- bold using **text**

Forbidden output examples:
<span class="text-white">
<div>
class="text-white">

If HTML formatting is required for UI, the frontend will handle styling.

This prevents the model from generating things like:

<span class="text-white">Total Mentions</span>
2. Add Backend Sanitization (Critical Safety Layer)

Even with prompt fixes, LLMs sometimes still produce HTML. Add a sanitizer before sending the response to the frontend.

Example (Node / JS):

function cleanAIResponse(text) {
  return text
    .replace(/class="[^"]*"/g, "")
    .replace(/<\/?span[^>]*>/g, "")
    .replace(/<\/?div[^>]*>/g, "")
    .replace(/text-[a-z0-9-]+/g, "")
}

Usage:

const aiResponse = await askAI(query)
const cleanResponse = cleanAIResponse(aiResponse)

return cleanResponse

This removes:

class="text-white"
<span>
</span>
text-white
3. Fix Frontend Rendering (Most Common Issue)

If you are using React Markdown, it may escape HTML incorrectly.

Use this safe configuration:

<ReactMarkdown
  skipHtml={true}
>
  {response}
</ReactMarkdown>

This prevents HTML fragments from rendering.

4. Quick Patch (If You Need a 30-Second Fix)

Before rendering the response in the UI:

response = response.replace(/text-white">/g, "")

This will immediately stop the visible bug.

Example Clean Output After Fix

Instead of this:

"text-white">pricing — Quantitative Summary
"text-white">Total Mentions: 78

You will get:

Pricing — Quantitative Summary

Total Mentions: 78
Meetings: 14

Evidence from each meeting with transcript snippets below.
(40 calls analyzed)
Best Long-Term Fix (Recommended)

Instead of letting the AI format text, make it return structured JSON:

Example AI response:

{
  "query_type": "count",
  "topic": "pricing",
  "total_mentions": 78,
  "meetings": 14
}