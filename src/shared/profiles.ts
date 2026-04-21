import { FrameState, FundidoConfig, OverlayGroup, ProfileId, RuleCondition } from './models/domain';

export function getActiveProfileIds(config: Pick<FundidoConfig, 'profiles'>): Set<ProfileId> {
  return new Set((config.profiles || []).filter((profile) => profile.active).map((profile) => profile.id));
}

export function applyProfileActivationToOverlayGroups(config: FundidoConfig): void {
  const profiles = config.profiles || [];
  if (profiles.length === 0) {
    return;
  }

  const activeProfileIds = getActiveProfileIds(config);
  for (const group of config.overlayGroups || []) {
    if (groupHasProfiles(group)) {
      group.enabled = groupBelongsToActiveProfile(group, activeProfileIds);
    }
  }
}

export function getProfileActivatedOverlayGroups(config: FundidoConfig): OverlayGroup[] {
  const profiles = config.profiles || [];
  if (profiles.length === 0) {
    return config.overlayGroups || [];
  }

  const activeProfileIds = getActiveProfileIds(config);
  return (config.overlayGroups || []).map((group) => ({
    ...group,
    enabled: groupHasProfiles(group)
      ? groupBelongsToActiveProfile(group, activeProfileIds)
      : group.enabled,
  }));
}

export function applyProfileRulesToConfig(config: FundidoConfig, frameState: FrameState): boolean {
  if (config.profileRulesEnabled !== true) {
    return false;
  }

  let changed = false;

  for (const profile of config.profiles || []) {
    const rules = profile.rules || [];
    if (rules.length === 0) {
      continue;
    }

    let nextActive = profile.active;
    for (const rule of rules) {
      const conditionsMatch = evaluateProfileRuleConditions(rule.conditions || [], rule.logicMode || 'AND', frameState);
      nextActive = (conditionsMatch ? rule.thenAction : rule.otherwiseAction) === 'activate';
    }

    if (profile.active !== nextActive) {
      profile.active = nextActive;
      changed = true;
    }
  }

  if (changed) {
    applyProfileActivationToOverlayGroups(config);
  }

  return changed;
}

export function getRegionIdsReferencedByProfileRules(config: Pick<FundidoConfig, 'profiles'>): Set<string> {
  const referencedIds = new Set<string>();
  for (const profile of config.profiles || []) {
    for (const rule of profile.rules || []) {
      for (const condition of rule.conditions || []) {
        if (condition.monitoredRegionId) {
          referencedIds.add(condition.monitoredRegionId);
        }
      }
    }
  }
  return referencedIds;
}

function groupHasProfiles(group: OverlayGroup): boolean {
  return (group.profileIds || []).length > 0;
}

function groupBelongsToActiveProfile(group: OverlayGroup, activeProfileIds: Set<ProfileId>): boolean {
  return (group.profileIds || []).some((profileId) => activeProfileIds.has(profileId));
}

function evaluateProfileRuleConditions(conditions: RuleCondition[], logicMode: string, frameState: FrameState): boolean {
  if (!conditions || conditions.length === 0) {
    return true;
  }

  if (!frameState?.regionStates) {
    return false;
  }

  for (const condition of conditions) {
    const regionState = frameState.regionStates.find((state) => state.monitoredRegionId === condition.monitoredRegionId);
    if (!regionState) {
      if (logicMode === 'AND') {
        return false;
      }
      continue;
    }

    const calcResult = regionState.calculationResults.find((result) => result.stateCalculationId === condition.stateCalculationId);
    if (!calcResult) {
      if (logicMode === 'AND') {
        return false;
      }
      continue;
    }

    let conditionResult = evaluateProfileRuleConditionOperator(condition, calcResult, frameState);
    if (condition.negate) {
      conditionResult = !conditionResult;
    }

    if (logicMode === 'OR' && conditionResult) {
      return true;
    }
    if (logicMode === 'AND' && !conditionResult) {
      return false;
    }
  }

  return logicMode === 'AND';
}

function evaluateProfileRuleConditionOperator(condition: RuleCondition, calcResult: any, frameState: FrameState): boolean {
  if (condition.operator === 'equals') {
    return calcResult.currentValue === condition.value;
  }

  if (condition.operator === 'notEquals') {
    return calcResult.currentValue !== condition.value;
  }

  const instanceStates = frameState?.regionInstanceStates || [];
  const matchingInstances = instanceStates.filter((instanceState) => instanceState.monitoredRegionId === condition.monitoredRegionId);
  if (matchingInstances.length === 0) {
    return false;
  }

  const matchingValues = matchingInstances.map((instanceState) =>
    instanceState.calculationResults.find((instanceCalcResult) =>
      instanceCalcResult.stateCalculationId === condition.stateCalculationId
    )?.currentValue,
  );

  if (condition.operator === 'equalsAtLeastOnceAcrossRepeatedRegions') {
    return matchingValues.some((value) => value === condition.value);
  }

  if (condition.operator === 'equalsInEveryRepeatedRegion') {
    return matchingValues.every((value) => value === condition.value);
  }

  if (condition.operator === 'equalsAtLeastNTimesAcrossRepeatedRegions') {
    const minCount = condition.minimumCount ?? 1;
    return matchingValues.filter((value) => value === condition.value).length >= minCount;
  }

  if (condition.operator === 'equalsInEverySelectedRepeatedRegion' || condition.operator === 'equalsAtLeastOnceInSelectedRepeatedRegions') {
    const selectedKeys = condition.selectedRepeatInstances || [];
    const selectedInstances = matchingInstances.filter(
      (instanceState) => selectedKeys.includes(`${instanceState.repeatIndexX}_${instanceState.repeatIndexY}`),
    );
    if (selectedInstances.length === 0) return false;
    const selectedValues = selectedInstances.map((instanceState) =>
      instanceState.calculationResults.find((r) => r.stateCalculationId === condition.stateCalculationId)?.currentValue,
    );
    if (condition.operator === 'equalsInEverySelectedRepeatedRegion') {
      return selectedValues.every((value) => value === condition.value);
    }
    return selectedValues.some((value) => value === condition.value);
  }

  return true;
}
