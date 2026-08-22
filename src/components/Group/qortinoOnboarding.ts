export const QORTINO_ONBOARDING_QORT_REQUIREMENT = 2;

export const hasRequiredQortinoOnboardingBalance = (
  balance: number | string | null | undefined,
  receivedPayments: number | null | undefined = null
) =>
  [balance, receivedPayments].some((candidate) => {
    if (candidate === null || candidate === undefined) return false;
    const amount = Number(candidate);
    return (
      Number.isFinite(amount) && amount >= QORTINO_ONBOARDING_QORT_REQUIREMENT
    );
  });
