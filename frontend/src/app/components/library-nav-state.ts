// Shared shape for navigating to the Calls Library page's HubSpot tab and
// deep-linking straight to one company's modal (optionally highlighting one
// deal within it) — e.g. from Insights' Sales stage modal.
export interface HubspotDealLinkState {
  hubspotCompanyId: string;
  hubspotDealId?: string;
}
