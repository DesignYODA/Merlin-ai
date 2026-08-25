// export interface Call {
//   id: string;
//   title: string;
//   clientName: string;
//   aeName: string;
//   date: string;
//   duration: string;
//   topics: string[];
//   sentiment: "positive" | "neutral" | "negative";
//   keyProductRequests: string[];
//   transcript: string;
//   aiSummary: string;
//   competitorsMentioned: string[];
//   featureRequests: string[];
//   recordingUrl: string;
// }

// export interface Mention {
//   callId: string;
//   callTitle: string;
//   aeName: string;
//   date: string;
//   entity: string;
//   mentionText: string;
// }

// export interface ChatMessage {
//   id: string;
//   role: "user" | "assistant";
//   content: string;
//   timestamp: string;
//   resultData?: {
//     totalMentions: number;
//     totalMeetings: number;
//     mentions: Mention[];
//   };
// }

// export interface InsightCard {
//   title: string;
//   value: string | number;
//   change: number;
//   icon: string;
// }

// export interface TopicItem {
//   topic: string;
//   count: number;
//   trend: "up" | "down" | "stable";
//   calls: string[];
// }

// export const mockCalls: Call[] = [
//   {
//     id: "1",
//     title: "Acme Corp Demo",
//     clientName: "Acme Corp",
//     aeName: "Sarah Lee",
//     date: "2026-03-10",
//     duration: "45 min",
//     topics: ["Pricing", "Integration", "Canada Expansion"],
//     sentiment: "positive",
//     keyProductRequests: ["API access", "SSO integration"],
//     transcript: "Sarah: Thanks for joining today. Let's walk through our platform...\nClient: We're particularly interested in expansion plans in Canada. Our Toronto office needs...\nSarah: Absolutely, we have strong Canadian compliance support...\nClient: What about pricing for enterprise?\nSarah: Let me walk you through our enterprise tiers...",
//     aiSummary: "Positive demo with Acme Corp focused on enterprise pricing and Canadian expansion. Client showed strong interest in API access and SSO integration. Follow-up scheduled for next week.",
//     competitorsMentioned: ["Gong", "Chorus"],
//     featureRequests: ["API access", "SSO integration", "Custom reporting"],
//     recordingUrl: "#",
//   },
//   {
//     id: "2",
//     title: "Fintech Discovery Call",
//     clientName: "PayFlow Inc",
//     aeName: "Rahul Shah",
//     date: "2026-03-09",
//     duration: "32 min",
//     topics: ["Compliance", "Security", "Canadian Market"],
//     sentiment: "neutral",
//     keyProductRequests: ["SOC2 compliance", "Data residency"],
//     transcript: "Rahul: Welcome to the discovery call. Tell me about your needs...\nClient: We need Canadian compliance requirements met. Our regulators...\nRahul: We understand the Canadian regulatory landscape well...\nClient: What about data residency in Canada?\nRahul: We offer Canadian data centers...",
//     aiSummary: "Discovery call with PayFlow Inc. Primary concerns around compliance and data residency in Canada. Client needs SOC2 certification confirmation before proceeding.",
//     competitorsMentioned: ["Salesforce", "HubSpot"],
//     featureRequests: ["Data residency options", "Compliance dashboard"],
//     recordingUrl: "#",
//   },
//   {
//     id: "3",
//     title: "TechStart Onboarding",
//     clientName: "TechStart",
//     aeName: "Maria Garcia",
//     date: "2026-03-08",
//     duration: "55 min",
//     topics: ["Onboarding", "Mobile App", "Integrations"],
//     sentiment: "positive",
//     keyProductRequests: ["Mobile app", "Slack integration"],
//     transcript: "Maria: Let's get you set up with the platform...\nClient: We really need mobile features. Our team is always on the go...\nMaria: I'll check with product on the mobile roadmap...\nClient: That would be great. Also, Slack integration is a must for us...",
//     aiSummary: "Successful onboarding session. Client emphasized need for mobile app and Slack integration. AE flagged mobile features as product request.",
//     competitorsMentioned: ["Zoom"],
//     featureRequests: ["Mobile app", "Slack integration", "Webhook support"],
//     recordingUrl: "#",
//   },
//   {
//     id: "4",
//     title: "GlobalTrade Quarterly Review",
//     clientName: "GlobalTrade Ltd",
//     aeName: "Sarah Lee",
//     date: "2026-03-07",
//     duration: "60 min",
//     topics: ["Renewal", "Expansion", "Canada", "Europe"],
//     sentiment: "positive",
//     keyProductRequests: ["Multi-currency support", "EU compliance"],
//     transcript: "Sarah: Let's review this quarter's usage...\nClient: We're expanding into Canada and Europe next quarter...\nSarah: Excellent! Our platform supports multi-region deployment...\nClient: We need multi-currency support. That's not supported currently, right?\nSarah: That's on the roadmap for Q3...",
//     aiSummary: "Quarterly review with positive sentiment. Client planning expansion to Canada and Europe. Multi-currency feature flagged as critical need. Renewal confirmed with expansion discussion.",
//     competitorsMentioned: [],
//     featureRequests: ["Multi-currency support", "EU data compliance", "Regional dashboards"],
//     recordingUrl: "#",
//   },
//   {
//     id: "5",
//     title: "HealthPlus Security Review",
//     clientName: "HealthPlus",
//     aeName: "Rahul Shah",
//     date: "2026-03-06",
//     duration: "40 min",
//     topics: ["HIPAA", "Security", "Audit"],
//     sentiment: "neutral",
//     keyProductRequests: ["HIPAA compliance", "Audit logs"],
//     transcript: "Rahul: Let's discuss your security requirements...\nClient: We need HIPAA compliance for our healthcare data...\nRahul: We don't have that feature yet, but it's being prioritized...\nClient: What about detailed audit logs?\nRahul: We have basic audit logs, enhanced version is coming...",
//     aiSummary: "Security-focused review. Client requires HIPAA compliance which is not yet available. Audit log enhancement also requested. Deal may be at risk without these features.",
//     competitorsMentioned: ["Veeva", "Salesforce Health Cloud"],
//     featureRequests: ["HIPAA compliance", "Enhanced audit logs", "Role-based access"],
//     recordingUrl: "#",
//   },
//   {
//     id: "6",
//     title: "RetailMax Integration Workshop",
//     clientName: "RetailMax",
//     aeName: "Maria Garcia",
//     date: "2026-03-05",
//     duration: "50 min",
//     topics: ["Shopify", "Integration", "Automation"],
//     sentiment: "positive",
//     keyProductRequests: ["Shopify connector", "Automated workflows"],
//     transcript: "Maria: Today we'll map out your integration needs...\nClient: Shopify is our primary platform. We need a native connector...\nMaria: I'll check with product on the Shopify integration timeline...\nClient: Also, can we automate order-to-delivery workflows?\nMaria: We have basic automation, advanced features are coming...",
//     aiSummary: "Productive integration workshop. Shopify connector identified as must-have. Client interested in advanced workflow automation. Good engagement overall.",
//     competitorsMentioned: ["Zapier", "Make"],
//     featureRequests: ["Shopify connector", "Advanced automation", "Custom triggers"],
//     recordingUrl: "#",
//   },
//   {
//     id: "7",
//     title: "EduTech Platform Demo",
//     clientName: "EduTech Solutions",
//     aeName: "Sarah Lee",
//     date: "2026-03-04",
//     duration: "35 min",
//     topics: ["LMS", "Analytics", "Pricing"],
//     sentiment: "negative",
//     keyProductRequests: ["LMS integration", "Student analytics"],
//     transcript: "Sarah: Let me show you our analytics capabilities...\nClient: We need LMS integration. Does your platform support that?\nSarah: We don't have that feature yet. It's something we're exploring...\nClient: That's a deal-breaker for us. What about student-level analytics?\nSarah: Our analytics are company-level currently...",
//     aiSummary: "Demo did not go well. Client requires LMS integration and student-level analytics, neither of which are currently available. High risk of losing this opportunity.",
//     competitorsMentioned: ["Canvas", "Blackboard"],
//     featureRequests: ["LMS integration", "Student analytics", "Custom roles"],
//     recordingUrl: "#",
//   },
//   {
//     id: "8",
//     title: "LogiFlow Pricing Negotiation",
//     clientName: "LogiFlow",
//     aeName: "Rahul Shah",
//     date: "2026-03-03",
//     duration: "28 min",
//     topics: ["Pricing", "Contract", "Discount"],
//     sentiment: "neutral",
//     keyProductRequests: ["Volume discount", "Annual billing"],
//     transcript: "Rahul: Let's discuss pricing options...\nClient: We need a significant volume discount for 500+ users...\nRahul: We can offer tiered pricing. Let me prepare a proposal...\nClient: We also want annual billing with monthly flexibility...\nRahul: I'll check with our billing team on that...",
//     aiSummary: "Pricing negotiation for 500+ user deployment. Client requesting volume discounts and flexible billing. Proposal to be prepared and shared within the week.",
//     competitorsMentioned: ["Outreach", "SalesLoft"],
//     featureRequests: ["Flexible billing", "Usage-based pricing"],
//     recordingUrl: "#",
//   },
// ];

// export const mockTopics: TopicItem[] = [
//   { topic: "Pricing", count: 24, trend: "up", calls: ["1", "4", "7", "8"] },
//   { topic: "Integration", count: 19, trend: "up", calls: ["1", "3", "6"] },
//   { topic: "Canada", count: 12, trend: "stable", calls: ["1", "2", "4"] },
//   { topic: "Compliance", count: 15, trend: "up", calls: ["2", "5"] },
//   { topic: "Mobile", count: 8, trend: "down", calls: ["3"] },
//   { topic: "Security", count: 11, trend: "stable", calls: ["2", "5"] },
//   { topic: "Automation", count: 7, trend: "up", calls: ["6"] },
//   { topic: "Analytics", count: 9, trend: "stable", calls: ["7"] },
//   { topic: "Onboarding", count: 6, trend: "down", calls: ["3"] },
//   { topic: "Expansion", count: 10, trend: "up", calls: ["1", "4"] },
// ];

// export const mockProductRequests = [
//   { id: "1", clientName: "Acme Corp", feature: "API access", aeName: "Sarah Lee", callTitle: "Acme Corp Demo", date: "2026-03-10", aePhrase: "I'll check with product" },
//   { id: "2", clientName: "PayFlow Inc", feature: "Data residency options", aeName: "Rahul Shah", callTitle: "Fintech Discovery Call", date: "2026-03-09", aePhrase: "We're working on that" },
//   { id: "3", clientName: "TechStart", feature: "Mobile app", aeName: "Maria Garcia", callTitle: "TechStart Onboarding", date: "2026-03-08", aePhrase: "I'll check with product on the mobile roadmap" },
//   { id: "4", clientName: "GlobalTrade Ltd", feature: "Multi-currency support", aeName: "Sarah Lee", callTitle: "GlobalTrade Quarterly Review", date: "2026-03-07", aePhrase: "That's on the roadmap for Q3" },
//   { id: "5", clientName: "HealthPlus", feature: "HIPAA compliance", aeName: "Rahul Shah", callTitle: "HealthPlus Security Review", date: "2026-03-06", aePhrase: "We don't have that feature yet" },
//   { id: "6", clientName: "RetailMax", feature: "Shopify connector", aeName: "Maria Garcia", callTitle: "RetailMax Integration Workshop", date: "2026-03-05", aePhrase: "I'll check with product" },
//   { id: "7", clientName: "EduTech Solutions", feature: "LMS integration", aeName: "Sarah Lee", callTitle: "EduTech Platform Demo", date: "2026-03-04", aePhrase: "We don't have that feature yet" },
//   { id: "8", clientName: "LogiFlow", feature: "Flexible billing", aeName: "Rahul Shah", callTitle: "LogiFlow Pricing Negotiation", date: "2026-03-03", aePhrase: "I'll check with our billing team" },
// ];

// export const weeklyCallVolume = [
//   { day: "Mon", calls: 8 },
//   { day: "Tue", calls: 12 },
//   { day: "Wed", calls: 15 },
//   { day: "Thu", calls: 10 },
//   { day: "Fri", calls: 7 },
//   { day: "Sat", calls: 2 },
//   { day: "Sun", calls: 1 },
// ];

// export const sentimentData = [
//   { name: "Positive", value: 45, fill: "#22c55e" },
//   { name: "Neutral", value: 35, fill: "#f59e0b" },
//   { name: "Negative", value: 20, fill: "#ef4444" },
// ];

// export const topMentionedCountries = [
//   { country: "Canada", mentions: 12 },
//   { country: "United States", mentions: 28 },
//   { country: "United Kingdom", mentions: 8 },
//   { country: "Germany", mentions: 5 },
//   { country: "Australia", mentions: 4 },
// ];

// export const topicsOverTime = [
//   { week: "W1", Pricing: 5, Integration: 3, Compliance: 2, Security: 4 },
//   { week: "W2", Pricing: 7, Integration: 5, Compliance: 4, Security: 3 },
//   { week: "W3", Pricing: 6, Integration: 7, Compliance: 5, Security: 5 },
//   { week: "W4", Pricing: 8, Integration: 6, Compliance: 6, Security: 4 },
// ];
