export interface HomeCopy {
  readonly description: string;
  readonly eyebrow: string;
  readonly headline: string;
}

export function getHomeCopy(appName: string): HomeCopy {
  return {
    description:
      "The deployable foundation is ready for source-grounded lessons, adaptive assessment, and a learner knowledge model.",
    eyebrow: `${appName} learning system`,
    headline: "Measure what learners retain.",
  };
}
