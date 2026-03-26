If the meeting title contains phrases indicating an interview round, the meeting must be ignored.

Examples of titles that must be excluded:

"Round 1"

"Round 2"

"Round 3"

"Interview Round 1"

"Interview Round 2"

"Technical Round"

"HR Round"

"Final Round"

"Candidate Interview"

"Hiring Discussion"

If the title contains keywords such as:

round

interview

candidate

hiring

technical round

hr round

then the meeting must be treated as a recruiting call and must be excluded.

Implementation Logic

Add this validation to the ingestion filter.

function isHiringMeeting(title){

  const lowerTitle = title.toLowerCase()

  const hiringKeywords = [
    "round 1",
    "round 2",
    "round 3",
    "round 4",
    "interview",
    "candidate",
    "technical round",
    "hr round",
    "final round",
    "hiring"
  ]

  return hiringKeywords.some(keyword => lowerTitle.includes(keyword))
}

Update the main filtering function:

function shouldAnalyzeMeeting(meeting){

  if(meeting.recorded_by == "Vishal Jetley") return false
  if(meeting.recorded_by == "Anish Khadiya") return false

  if(meeting.title == "Weekly Sales Huddle") return false

  if(isHiringMeeting(meeting.title)) return false

  const participants = meeting.participants

  const externalExists = participants.some(email => {
    return !email.endsWith("@itilite.com") && !email.endsWith("@fireflies.ai")
  })

  if(!externalExists) return false

  return true
}
Query Layer Safeguard

Even if some hiring meetings were accidentally indexed earlier, the Ask AI system must still exclude them.

Add metadata filtering:

WHERE is_hiring_meeting = false
AND recorded_by NOT IN ("Vishal Jetley","Anish Khadiya")
AND meeting_title != 'Weekly Sales Huddle'
AND has_external_participant = true
Metadata to Store Per Call

During ingestion, attach these flags:

is_hiring_meeting
is_internal_meeting
is_excluded_host
has_external_participant

Then only index meetings where:

is_hiring_meeting = false
AND is_internal_meeting = false
AND is_excluded_host = false