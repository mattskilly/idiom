export declare const fixtureRoot: string;
export declare const toolbarCss: string;
export declare const goodGap: string;
export declare const plantedGap: string;

export type IdiomRunner = (
  directory: string,
  args: string[],
) => Promise<{ status: number; out: string; err: string }>;

export type FixFixture = {
  directory: string;
  port: number;
  base: string;
  baseline: string;
  change: string;
  git: (...args: string[]) => Promise<string>;
  commit: (message: string) => Promise<string>;
  cleanup: () => Promise<void>;
};

export declare function createFixFixture(options: {
  idiom: IdiomRunner;
  start?: string | undefined;
  directory?: string | undefined;
}): Promise<FixFixture>;

export declare function scriptedFix(root: string): Promise<string[]>;
