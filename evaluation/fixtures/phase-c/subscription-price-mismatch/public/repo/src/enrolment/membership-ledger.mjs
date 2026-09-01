const memberships = [];

export const membershipLedger = {
  save(membership) {
    memberships.push(membership);
    return membership;
  },
  all() {
    return memberships.slice();
  },
  forPlan(planId) {
    return memberships.filter((membership) => membership.planId === planId);
  },
};
