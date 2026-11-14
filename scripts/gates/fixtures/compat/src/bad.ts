export const sorted = (values: number[]): number[] => values.toSorted();

export const grouped = (items: string[]): Record<string, string[]> =>
  Object.groupBy(items, (item) => String(item.length));

export const limited = (): Promise<void> => Promise.withResolvers<void>().promise;

export const replaced = (values: number[]): number[] => values.with(0, 1);

export const combined = (first: AbortSignal, second: AbortSignal): AbortSignal =>
  AbortSignal.any([first, second]);

export const parsed = (text: string): URL | null => URL.parse(text);

export const yielded = async (): Promise<void> => {
  await scheduler.yield();
};
