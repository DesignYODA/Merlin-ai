import datetime
import email
import uuid
from pydantic import BaseModel, Field

# ─── Schemas ────────────────────────────────────────────────────────────────────
class UserSchema(BaseModel):
    # User data
    user_id: uuid.UUID = Field(default_factory=uuid.uuid4, description="User ID")
    email: str = Field(default="", description="User email")
    name: str = Field(default="", description="User name")
    display_name: str = Field(default="", description="User display name")
    phone_number: str = Field(default="", description="User phone number")
    location: str = Field(default="", description="User location")
    created_at: datetime.datetime = Field(default_factory=datetime.datetime.now, description="Creation timestamp")
    last_active_at: datetime.datetime = Field(default_factory=datetime.datetime.now, description="Last active timestamp")

class ChatSessionSchema(BaseModel):
    # Chat session data
    chat_id: uuid.UUID = Field(default_factory=uuid.uuid4, description="Chat session ID")
    user_id: uuid.UUID = Field(default_factory=uuid.uuid4, description="User ID. Foreign for the ChatSession table. Same userid as user_id")
    created_at: datetime.datetime = Field(default_factory=datetime.datetime.now, description="Creation timestamp")
    chat_summary: str = Field(default="", description="Chat summary of the conversation when user logs out. This is fetched for subsquent chat sessions.")
    session_id: str = Field(default="", description="Session ID. A single chat_id can have multiple session_ids. This is used to identify the chat session.")
    ttl: int = Field(default=604800, description="Time to live in seconds. This is the time after creation which the chat session is considered expired.")

# ─── HubSpot ────────────────────────────────────────────────────────────────────
# class HubspotDealAssociation(BaseModel):
#     companies: list[str] = Field(default=[], description="List of company IDs")
#     notes: list[str] = Field(default=[], description="List of note IDs")
#     contacts: list[str] = Field(default=[], description="List of contact IDs")
class HubspotEmailProperties(BaseModel):
    hs_createdate: str = Field(default="", description="Email creation date")
    hs_email_subject: str = Field(default="", description="Email subject")
    hs_email_text: str = Field(default="", description="Email text")
    hs_lastmodifieddate: str = Field(default="", description="Email last modified date")
    hs_object_id: str = Field(default="", description="HubSpot object ID")
    hs_timestamp: str = Field(default="", description="Email timestamp")
    hubspot_owner_id: str = Field(default="", description="HubSpot owner ID")

class HubspotEmail(BaseModel):
    # Email data
    id: str = Field(default="", description="HubSpot email ID")
    properties: HubspotEmailProperties= Field(default_factory=HubspotEmailProperties, description="Email properties")
    createdAt: str = Field(default="", description="Creation timestamp. In YYYY-MM-DDTHH:MM:SS.sssZ format")
    updatedAt: str = Field(default="", description="Updated timestamp. In YYYY-MM-DDTHH:MM:SS.sssZ format")
    archived: bool = Field(default=False, description="Archived status")
    url: str = Field(default="", description="URL to the email on HubSpot. This is returned as url.")

class HubspotContactProperties(BaseModel):
    firstname: str = Field(default="", description="Contact first name")
    lastname: str = Field(default="", description="Contact last name")
    email: str = Field(default="", description="Contact email")
    createdate: str = Field(default="", description="Contact creation date")
    lastmodifieddate: str = Field(default="", description="Contact last modified date")

class HubspotContact(BaseModel):
    # Contact data
    id: str = Field(default="", description="HubSpot contact ID")
    properties: HubspotContactProperties = Field(default_factory=HubspotContactProperties, description="Contact properties")
    createdAt: str = Field(default="", description="Creation timestamp. In YYYY-MM-DDTHH:MM:SS.sssZ format")
    updatedAt: str = Field(default="", description="Updated timestamp. In YYYY-MM-DDTHH:MM:SS.sssZ format")
    archived: bool = Field(default=False, description="Archived status")
    url: str = Field(default="", description="URL to the contact on HubSpot. This is returned as url.")

class HubspotDealProperties(BaseModel):
    dealname: str = Field(default="", description="Deal name")
    amount: str = Field(default="", description="Deal amount")
    dealstage: str = Field(default="", description="Deal stage")
    closedate: str = Field(default="", description="Deal closed date")
    pipeline: str = Field(default="", description="Deal pipeline")
    hubspot_owner_id: str = Field(default="", description="HubSpot owner ID")
    createdate: str = Field(default="", description="Deal creation date")
    hs_lastmodifieddate: str = Field(default="", description="HubSpot last modified date in YYYY-MM-DDTHH:MM:SS.sssZ format")
    hs_object_id: str = Field(default="", description="HubSpot object ID")

class HubspotDeals(BaseModel):
    id: str = Field(default="", description="HubSpot deal ID")
    properties: HubspotDealProperties
    createdAt: str = Field(default="", description="Creation timestamp. An YYYY-MM-DDTHH:MM:SS.sssZ format")
    updatedAt: str = Field(default="", description="Updated timestamp. An YYYY-MM-DDTHH:MM:SS.sssZ format")
    archivedAt: str = Field(default="", description="Archived timestamp. An YYYY-MM-DDTHH:MM:SS.sssZ format")
    url: str = Field(default="", description="URL to the deal on HubSpot. This is returned as url.")

class HubspotNoteProperties(BaseModel):
    hs_note_body: str = Field(default="", description="Note body")
    hs_createdate: str = Field(default="", description="Note creation date in YYYY-MM-DDTHH:MM:SS.sssZ format")
    hs_lastmodifieddate: str = Field(default="", description="Note last modified date in YYYY-MM-DDTHH:MM:SS.sssZ format")
    hs_object_id: str = Field(default="", description="HubSpot object ID")
    hs_timestamp: str = Field(default="", description="Note timestamp in YYYY-MM-DDTHH:MM:SS.sssZ format")
    hubspot_owner_id: str = Field(default="", description="HubSpot owner ID")
    hs_attachment_ids: list[str] = Field(default=[], description="List of attachment IDs")

class HubspotNotes(BaseModel):
    id: str = Field(default="", description="HubSpot note ID")
    properties: HubspotNoteProperties
    createdAt: str = Field(default="", description="Creation timestamp. An YYYY-MM-DDTHH:MM:SS.sssZ format")
    updatedAt: str = Field(default="", description="Updated timestamp. An YYYY-MM-DDTHH:MM:SS.sssZ format")
    archivedAt: str = Field(default="", description="Archived timestamp. An YYYY-MM-DDTHH:MM:SS.sssZ format")
    url: str = Field(default="", description="URL to the note on HubSpot. This is returned as url.")

class HubspotCompanyProperties(BaseModel):
    name: str = Field(default="", description="Company name")
    domain: str = Field(default="", description="Company domain")
    phone: str = Field(default="", description="Company phone number")
    city: str = Field(default="", description="Company city")
    state: str = Field(default="", description="Company state")
    country: str = Field(default="", description="Company country")
    industry: str = Field(default="", description="Company industry")
    createdate: str = Field(default="", description="Company creation date")
    lifecyclestage: str = Field(default="", description="Company lifecycle stage")
    hubspot_owner_id: str = Field(default="", description="HubSpot owner ID")
    hs_lastmodifieddate: str = Field(default="", description="HubSpot last modified date in YYYY-MM-DDTHH:MM:SS.sssZ format")
    hs_object_id: str = Field(default="", description="HubSpot object ID")

class Association(BaseModel):
    results: list[dict] = Field(default=[], description="List of email IDs")
    paging: list[list] = Field(default=[], description="Pagination")

class HubspotCompanyAssociations(BaseModel):
    emails: Association = Field(default=[], description="List of email IDs")
    contacts: Association = Field(default=[], description="List of contact IDs")
    deals: Association = Field(default=[], description="List of deal IDs")
    notes: Association = Field(default=[], description="List of note IDs")
    calls: Association = Field(default=[], description="List of call IDs")

class HubspotCompanies(BaseModel):
    id: str = Field(default="", description="HubSpot company ID")
    properties: HubspotCompanyProperties
    createdAt: str = Field(default="", description="Creation timestamp. An YYYY-MM-DDTHH:MM:SS.sssZ format")
    updatedAt: str = Field(default="", description="Updated timestamp. An YYYY-MM-DDTHH:MM:SS.sssZ format")
    archivedAt: str = Field(default="", description="Archived timestamp. An YYYY-MM-DDTHH:MM:SS.sssZ format")
    archived: bool = Field(default=False, description="True if archived")
    url: str = Field(default="", description="URL to the company on HubSpot. This is returned as url.")
    associations: HubspotCompanyAssociations = Field(default_factory=HubspotCompanyAssociations, description="Associations")

# ─── DB row models (hubspot_data.sqlite — three normalized tables) ─────────────
# Flow: companies API → save to companies table.
#       associations give deal_ids / note_ids → fetch each → save to deals / notes tables.
#       A company can have many deals and many notes.

class HubspotData(BaseModel):
    """Flat view: one row per company, joined with primary deal and most-recent note."""
    # ── Company ──────────────────────────────────────────────────────────────────
    company_id:                  str       = Field(default="", description="PK — HubSpot company ID")
    company_name:                str       = Field(default="")
    company_domain:              str       = Field(default="")
    company_phone:               str       = Field(default="")
    company_city:                str       = Field(default="")
    company_state:               str       = Field(default="")
    company_country:             str       = Field(default="")
    company_industry:            str       = Field(default="")
    company_createdate:          str       = Field(default="")
    company_lifecyclestage:      str       = Field(default="")
    company_hubspot_owner_id:    str       = Field(default="")
    company_hs_lastmodifieddate: str       = Field(default="")
    company_synced_at:           int       = Field(default=0)
    # ── Deal / Note / Email / Contact IDs (all associated) ───────────────────────
    deal_ids:                    list[str] = Field(default=[], description="All associated HubSpot deal IDs")
    note_ids:                    list[str] = Field(default=[], description="All associated HubSpot note IDs")
    email_ids:                   list[str] = Field(default=[], description="All associated HubSpot email IDs")
    contact_ids:                 list[str] = Field(default=[], description="All associated HubSpot contact IDs")
    # ── Primary deal (most recent by close date) ─────────────────────────────────
    deal_id:                     str       = Field(default="")
    deal_name:                   str       = Field(default="")
    deal_amount:                 str       = Field(default="")
    deal_stage:                  str       = Field(default="")
    deal_closedate:              str       = Field(default="")
    deal_pipeline:               str       = Field(default="")
    deal_hubspot_owner_id:       str       = Field(default="")
    deal_createdate:             str       = Field(default="")
    deal_hs_lastmodifieddate:    str       = Field(default="")
    # ── Most-recent note ─────────────────────────────────────────────────────────
    note_id:                     str       = Field(default="")
    note_hs_note_body:           str       = Field(default="")
    note_hs_createdate:          str       = Field(default="")
    note_hs_lastmodifieddate:    str       = Field(default="")
    note_hubspot_owner_id:       str       = Field(default="")
    note_hs_timestamp:           str       = Field(default="")
    # ── Emails ────────────────────────────────────────────────────────────────────────
    email_id:                    str       = Field(default="")
    email_hs_createdate:        datetime.datetime = Field(default_factory=datetime.datetime.now, description="Creation timestamp")
    email_hs_email_subject:     str       = Field(default="")
    email_hs_email_text:        str       = Field(default="")
    email_hs_lastmodifieddate:  datetime.datetime = Field(default_factory=datetime.datetime.now, description="Last updated timestamp")
    email_hs_object_id:         str       = Field(default="")
    email_hs_timestamp:         str       = Field(default="")
    email_hubspot_owner_id:     str       = Field(default="")
    email_createdAt:            datetime.datetime = Field(default_factory=datetime.datetime.now, description="Creation timestamp")
    email_updatedAt:            datetime.datetime = Field(default_factory=datetime.datetime.now, description="Last updated timestamp")
    email_archived:             bool       = Field(default=False, description="True if archived")
    email_url:                  str       = Field(default="")
    # ── Full lists for modal ──────────────────────────────────────────────────────
    all_deals:                   list[dict] = Field(default=[])
    all_notes:                   list[dict] = Field(default=[])
    all_emails:                  list[dict] = Field(default=[])
    all_contacts:                list[dict] = Field(default=[])




# class MarketingAnalytics(BaseModel):
#     # ── Marketing Analytics ────────────────────────────────────────────────────── 


# class SalesAnalytics(BaseModel):
#     # ── Sales Analytics ──────────────────────────────────────────────────────
#     calls


class Toptopics(BaseModel):
    # ── Top Topics ────────────────────────────────────────────────────────────────
    topic: str = Field(default="", description="Topic")
    count: int = Field(default=0, description="Call count")
    call_ids: list[str] = Field(default=[], description="Call IDs")
    computed_at: int = Field(default=0, description="Computed at")

class ProductAnalytics(BaseModel):
    # ── Product Analytics ──────────────────────────────────────────────────────
    keyword_ranking: list[dict] = Field(default=[], description="Keyword rankings")
    keyword_trending: list[dict] = Field(default=[], description="Fireflies keyword trends")
    trending_topics: list[Toptopics] = Field(default=[], description="Top topics")

class TopAES(BaseModel):
    # ── Top AEs ────────────────────────────────────────────────────────────────
    ae_name: str = Field(default="", description="AE name")
    ae_email: str = Field(default="", description="AE email")
    call_count: int = Field(default=0, description="Call count")
    computed_at: int = Field(default=0, description="Computed at")

class FoundersAnalytics(BaseModel):
    # ── Founders Analytics ──────────────────────────────────────────────────────
    key_initiators: int = Field(default=0, description="Key initator across hubspot deals")
    call_sentiment_trending: list[dict] = Field(default=[], description="Call sentiment trends")
    competitors_trend: list[dict] = Field(default=[], description="Competitors name trends")
    top_aes: list[TopAES] = Field(default=[], description="Top AEs")