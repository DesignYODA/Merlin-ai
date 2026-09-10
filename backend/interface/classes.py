from typing import Any
from pydantic import BaseModel

class ApiKeyBody(BaseModel):
    apiKey: str

class AnalyzeBody(BaseModel):
    callIds: list[str] | None = None
    force: bool = False

class HubSpotSearchBody(BaseModel):
    model_config = {"extra": "allow"}

class RewriteQueryBody(BaseModel):
    currentQuery: str
    previousResponseSummary: str | None = None
    previousQueries: list[str] | None = None
    conversationHistory: list[dict] | None = None

class FinalResponseBody(BaseModel):
    resultData: Any
    parsedQuery: Any = None
    formattedIntro: str | None = None

class IngestHistoricalBody(BaseModel):
    dir: str

class UpsertUserBody(BaseModel):
    email: str
    name: str = ""
    display_name: str = ""

class CreateSessionBody(BaseModel):
    user_id: str
    session_id: str | None = None
    messages: list | None = None

class UpdateSessionBody(BaseModel):
    messages: list | None = None
    chat_summary: str | None = None

class GenerateTitleBody(BaseModel):
    first_message: str

class AskHubspotRowBody(BaseModel):
    context: dict = {}
    question: str

class SignupBody(BaseModel):
    email: str
    username: str
    password: str
    securityquestion: str
    answer: str
    title: str = ""
    role: str = "member"

class LoginBody(BaseModel):
    email: str
    password: str

class SecurityQuestionBody(BaseModel):
    email: str

class ResetPasswordBody(BaseModel):
    email: str
    answer: str
    new_password: str