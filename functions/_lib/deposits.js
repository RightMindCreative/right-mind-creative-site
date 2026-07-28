const FIXED_DEPOSITS = Object.freeze({
  recording: 7000,
  production: 9000,
  mixing: 15000,
});

export const depositForApplication = (application, customAmount) => {
  const category = String(application.category || "").toLowerCase();
  if (category === "packages") {
    const dollars = Number(customAmount);
    if (!Number.isFinite(dollars) || dollars < 1 || dollars > 100000) {
      throw new Error("Enter a valid custom package deposit.");
    }
    return Math.round(dollars * 100);
  }
  const amount = FIXED_DEPOSITS[category];
  if (!amount) throw new Error("This service does not have a deposit rule.");
  return amount;
};

export const formatDeposit = (cents) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: Number(cents) % 100 ? 2 : 0,
}).format(Number(cents || 0) / 100);
