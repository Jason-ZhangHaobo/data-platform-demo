export const fundContextIds: readonly string[];
export const fundContextId: string;
export const isFundContext: (id: string | undefined) => boolean;
export const fundCase: (id: string | undefined) => {id:string;file:string;rehearsalDate:string} | undefined;
export const fundRehearsalAt: (id: string | undefined) => string | undefined;
