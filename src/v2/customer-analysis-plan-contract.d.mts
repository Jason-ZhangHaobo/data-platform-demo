export const customerAnalysisKind: 'MYSQL_HOLDINGS_CUSTOMER_ANALYSIS';
export const customerBalanceMetrics: readonly string[];
export const customerDistributionMetrics: readonly string[];
export const customerAnalysisMetrics: readonly string[];
export function requestsCustomerAnalysis(ids:unknown):boolean;
export function hasCustomerBalanceWidgets(widgets:unknown):boolean;
export function matchesCustomerAnalysisProposal(proposal:unknown):boolean;
