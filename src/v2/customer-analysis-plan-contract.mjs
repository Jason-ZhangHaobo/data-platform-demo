export const customerAnalysisKind = 'MYSQL_HOLDINGS_CUSTOMER_ANALYSIS';
export const customerBalanceMetrics = Object.freeze(['total_assets','holding_value','client_security_count']);
export const customerDistributionMetrics = Object.freeze(['asset_class_distribution','industry_distribution']);
export const customerAnalysisMetrics = Object.freeze([...customerBalanceMetrics,...customerDistributionMetrics]);

const sameSet=(values,expected)=>Array.isArray(values)&&values.length===expected.length&&expected.every(id=>values.includes(id));
export const requestsCustomerAnalysis=ids=>sameSet(ids,customerAnalysisMetrics);
export const hasCustomerBalanceWidgets=widgets=>Array.isArray(widgets)&&sameSet(widgets.map(widget=>widget?.id),customerBalanceMetrics);

export function matchesCustomerAnalysisProposal(proposal) {
  const analysis=proposal?.customerAnalysis;
  return analysis?.kind===customerAnalysisKind && Object.keys(analysis).length===2 &&
    sameSet(analysis.metricIds,customerDistributionMetrics) && requestsCustomerAnalysis(proposal.metricIds) &&
    hasCustomerBalanceWidgets(proposal.widgets);
}
