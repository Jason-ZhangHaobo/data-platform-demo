import cases from "../../fixtures/fund-lookthrough/cases.json" with { type: "json" };

export const fundContextIds = Object.freeze(cases.map(item => item.id));
export const fundContextId = fundContextIds[0];
export const isFundContext = id => fundContextIds.includes(id);
export const fundCase = id => cases.find(item => item.id === id);
export const fundRehearsalAt = id => {
  const entry = fundCase(id);
  return entry && entry.rehearsalDate + "T09:00:00+08:00";
};
