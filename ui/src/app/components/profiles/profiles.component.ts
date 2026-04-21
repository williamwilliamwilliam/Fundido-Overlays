import { ChangeDetectorRef, Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../services/electron.service';
import { PendingChangesComponent } from '../../guards/pending-changes.guard';

@Component({
  selector: 'app-profiles',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="page">
      <h2>Profiles</h2>
      <p class="description">
        Choose which profiles are active to show different sets of Overlay Groups based on your current task. Define Rules to automatically change profiles. Overlay Groups assigned to active profiles are enabled automatically.
      </p>

      <div class="toolbar">
        <button (click)="saveProfiles()" [disabled]="!hasUnsavedChanges">
          {{ hasUnsavedChanges ? 'Save (Ctrl+S)' : 'Saved' }}
        </button>
        <button class="primary" (click)="addProfile()">+ Add Profile</button>
      </div>

      <label class="automation-toggle">
        <input
          type="checkbox"
          [(ngModel)]="profileRulesEnabled"
          (ngModelChange)="onProfileRulesAutomationChanged()" />
        Automatically Activate/Inactivate Profiles based on Rules
      </label>

      <div *ngIf="profiles.length === 0" class="empty-state">
        No profiles defined yet. Add a profile to start grouping Overlay Groups.
      </div>

      <div class="profiles-list">
        <div *ngFor="let profile of profiles; let profileIndex = index" class="profile-card">
          <div class="profile-row">
            <label class="active-toggle" title="Enable/disable this profile">
              <input
                type="checkbox"
                [(ngModel)]="profile.active"
                [disabled]="profileRulesEnabled && hasProfileRules(profile)"
                (ngModelChange)="onProfilesChanged()" />
              Active
            </label>
            <input
              [(ngModel)]="profile.name"
              (ngModelChange)="onProfilesChanged()"
              placeholder="Profile name"
              class="profile-name"
              [attr.data-profile-name-id]="profile.id" />
            <span class="group-count">{{ getProfileGroupCount(profile.id) }} groups</span>
            <button class="danger-text" (click)="deleteProfile(profileIndex)">Delete</button>
          </div>

          <div class="rules-header">
            <span class="section-label">Profile Rules</span>
            <button class="add-btn" (click)="addProfileRule(profile)">+ Add Rule</button>
          </div>

          <div *ngIf="!profile.rules || profile.rules.length === 0" class="rules-empty">
            No profile rules. Manual active state applies until a rule is added.
          </div>

          <div *ngFor="let rule of profile.rules; let ruleIndex = index" class="rule-row">
            <div class="rule-line">
              <span class="rule-keyword">When</span>
              <select [(ngModel)]="rule.logicMode" (ngModelChange)="onProfilesChanged()">
                <option value="AND">Every Condition is true</option>
                <option value="OR">At least one Condition is true</option>
              </select>
              <button class="danger-text small" (click)="deleteProfileRule(profile, ruleIndex)">Delete Rule</button>
            </div>

            <div class="conditions-list">
              <div *ngFor="let condition of rule.conditions; let conditionIndex = index" class="condition-row">
                <span class="rule-keyword condition-joiner" *ngIf="conditionIndex > 0">{{ rule.logicMode || 'AND' }}</span>
                <label class="not-checkbox" title="Invert this condition">
                  <input type="checkbox" [(ngModel)]="condition.negate" (ngModelChange)="onProfilesChanged()" />
                  NOT
                </label>
                <select [(ngModel)]="condition.monitoredRegionId" (ngModelChange)="onRegionSelectedForCondition(condition)">
                  <option value="">Select Region</option>
                  <option *ngFor="let region of monitoredRegions" [ngValue]="region.id">{{ region.name }}</option>
                </select>
                <select [(ngModel)]="condition.stateCalculationId" (ngModelChange)="onCalculationSelectedForCondition(condition)">
                  <option value="">Select Calc</option>
                  <option *ngFor="let calc of getCalcsForRegion(condition.monitoredRegionId)" [ngValue]="calc.id">{{ calc.name }}</option>
                </select>
                <select [(ngModel)]="condition.operator" (ngModelChange)="onProfilesChanged()">
                  <option value="equals">=</option>
                  <option value="notEquals">≠</option>
                  <option *ngIf="isRepeatingRegion(condition.monitoredRegionId)" value="equalsAtLeastOnceAcrossRepeatedRegions">
                    At least once across Repeated Regions
                  </option>
                  <option *ngIf="isRepeatingRegion(condition.monitoredRegionId)" value="equalsInEveryRepeatedRegion">
                    In every Repeated Region
                  </option>
                  <option *ngIf="isRepeatingRegion(condition.monitoredRegionId)" value="equalsAtLeastNTimesAcrossRepeatedRegions">
                    Occurs a minimum number of times
                  </option>
                  <option *ngIf="isRepeatingRegion(condition.monitoredRegionId)" value="equalsInEverySelectedRepeatedRegion">
                    In Every Selected Region
                  </option>
                  <option *ngIf="isRepeatingRegion(condition.monitoredRegionId)" value="equalsAtLeastOnceInSelectedRepeatedRegions">
                    At Least One Selected Region
                  </option>
                </select>
                <input *ngIf="condition.operator === 'equalsAtLeastNTimesAcrossRepeatedRegions'"
                  type="number" min="1" [(ngModel)]="condition.minimumCount" (ngModelChange)="onProfilesChanged()"
                  class="minimum-count-input" placeholder="Min" />
                <div *ngIf="condition.operator === 'equalsInEverySelectedRepeatedRegion' || condition.operator === 'equalsAtLeastOnceInSelectedRepeatedRegions'"
                  class="repeat-instance-selector">
                  <label *ngFor="let inst of getRepeatInstanceOptions(condition.monitoredRegionId)" class="repeat-instance-option">
                    <input type="checkbox"
                      [checked]="isRepeatInstanceSelected(condition, inst.key)"
                      (change)="toggleRepeatInstance(condition, inst.key)" />
                    {{ inst.label }}
                  </label>
                </div>
                <select
                  *ngIf="getCalcType(condition.monitoredRegionId, condition.stateCalculationId) !== 'OllamaLLM'"
                  [(ngModel)]="condition.value"
                  (ngModelChange)="onProfilesChanged()">
                  <option value="">Select Value</option>
                  <option *ngFor="let value of getStateValuesForCalc(condition.monitoredRegionId, condition.stateCalculationId)" [ngValue]="value">{{ value }}</option>
                </select>
                <input
                  *ngIf="getCalcType(condition.monitoredRegionId, condition.stateCalculationId) === 'OllamaLLM'"
                  [(ngModel)]="condition.value"
                  (ngModelChange)="onProfilesChanged()"
                  placeholder="Expected response"
                  class="condition-value-input" />
                <span
                  class="condition-debug-status"
                  [class.condition-debug-status-true]="isConditionTrue(condition)"
                  [class.condition-debug-status-false]="!isConditionTrue(condition)">
                  Condition = {{ isConditionTrue(condition) ? 'TRUE' : 'FALSE' }}
                </span>
                <button class="danger-text small" (click)="deleteProfileRuleCondition(rule, conditionIndex)">Remove Condition</button>
              </div>
              <button class="add-btn small" (click)="addProfileRuleCondition(rule)">+ Condition</button>
            </div>

            <div class="rule-outcome-row">
              <span class="rule-keyword">Then</span>
              <select [(ngModel)]="rule.thenAction" (ngModelChange)="onProfilesChanged()">
                <option value="activate">Automatically Activate</option>
                <option value="inactivate">Automatically Inactivate</option>
              </select>
              <span class="rule-keyword">Otherwise</span>
              <select [(ngModel)]="rule.otherwiseAction" (ngModelChange)="onProfilesChanged()">
                <option value="activate">Automatically Activate</option>
                <option value="inactivate">Automatically Inactivate</option>
              </select>
              <span
                class="rule-result-status"
                [class.rule-result-status-active]="getProfileRuleResult(rule) === 'Active'"
                [class.rule-result-status-inactive]="getProfileRuleResult(rule) === 'Inactive'">
                {{ getProfileRuleResult(rule) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .page { max-width: 900px; }
    h2 { margin-bottom: var(--spacing-sm); }
    .description { color: var(--color-text-secondary); margin-bottom: var(--spacing-lg); }
    .toolbar { display: flex; gap: var(--spacing-sm); margin-bottom: var(--spacing-md); flex-wrap: wrap; }
    .automation-toggle {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      width: fit-content;
      margin-bottom: var(--spacing-md);
      color: var(--color-text-secondary);
      font-size: 0.9rem;
      cursor: pointer;
    }
    .automation-toggle input { width: 18px; height: 18px; accent-color: var(--color-accent); }
    .empty-state {
      color: var(--color-text-secondary);
      font-style: italic;
      padding: var(--spacing-lg);
      text-align: center;
      border: 1px dashed var(--color-border);
      border-radius: var(--radius-md);
    }
    .profiles-list { display: flex; flex-direction: column; gap: var(--spacing-md); }
    .profile-card {
      background-color: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
    }
    .profile-row {
      display: grid;
      grid-template-columns: 110px minmax(220px, 1fr) 90px auto;
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-md);
    }
    .active-toggle {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      color: var(--color-text-secondary);
      cursor: pointer;
      font-size: 0.85rem;
    }
    .active-toggle input { width: 18px; height: 18px; accent-color: var(--color-accent); }
    .profile-name { width: 100%; }
    .group-count { color: var(--color-text-secondary); font-size: 0.85rem; text-align: right; }
    .rules-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--spacing-sm);
      border-top: 1px solid var(--color-border);
      padding-top: var(--spacing-sm);
    }
    .section-label {
      color: var(--color-text-secondary);
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .rules-empty { color: var(--color-text-secondary); font-size: 0.85rem; font-style: italic; }
    .rule-row {
      background-color: var(--color-bg-primary);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
    }
    .rule-line, .condition-row, .rule-outcome-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      flex-wrap: wrap;
      margin-bottom: var(--spacing-sm);
    }
    .rule-outcome-row { margin-bottom: 0; }
    .rule-keyword { color: var(--color-text-secondary); font-size: 0.8rem; text-transform: uppercase; }
    .conditions-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      margin-bottom: var(--spacing-sm);
    }
    .not-checkbox {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      color: var(--color-text-secondary);
      font-size: 0.8rem;
    }
    .condition-value-input { min-width: 160px; }
    .minimum-count-input { width: 54px; font-size: 0.8rem; }
    .repeat-instance-selector { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; padding: 2px 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg-primary); }
    .repeat-instance-option { display: flex; align-items: center; gap: 2px; font-size: 0.75rem; white-space: nowrap; cursor: pointer; }
    .condition-debug-status {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      font-weight: 700;
      white-space: nowrap;
    }
    .condition-debug-status-true { color: var(--color-success); }
    .condition-debug-status-false { color: var(--color-error); }
    .rule-result-status {
      font-family: var(--font-mono);
      font-size: 0.8rem;
      font-weight: 700;
      white-space: nowrap;
    }
    .rule-result-status-active { color: var(--color-success); }
    .rule-result-status-inactive { color: var(--color-error); }
    .add-btn { font-size: 0.8rem; padding: 2px 10px; }
    .small { font-size: 0.75rem; padding: 2px 8px; }
    .danger-text {
      color: var(--color-error);
      background: transparent;
      border-color: transparent;
      padding: var(--spacing-xs);
    }
    .danger-text:hover { background-color: rgba(244, 67, 54, 0.12); }
  `],
})
export class ProfilesComponent implements OnInit, OnDestroy, PendingChangesComponent {
  profiles: any[] = [];
  overlayGroups: any[] = [];
  monitoredRegions: any[] = [];
  profileRulesEnabled = false;
  hasUnsavedChanges = false;
  private currentFrameState: any | null = null;
  private stateSubscription: Subscription | null = null;
  private viewRefreshScheduled = false;

  constructor(
    private readonly electronService: ElectronService,
    private readonly changeDetectorRef: ChangeDetectorRef,
  ) {}

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    const isCtrlS = (event.ctrlKey || event.metaKey) && event.key === 's';
    if (!isCtrlS) {
      return;
    }

    event.preventDefault();
    if (this.hasUnsavedChanges) {
      this.saveProfiles();
    }
  }

  async ngOnInit(): Promise<void> {
    this.electronService.setActivePage('profiles');
    const config = await this.electronService.loadConfig();
    this.profiles = JSON.parse(JSON.stringify(config.profiles || []));
    this.overlayGroups = JSON.parse(JSON.stringify(config.overlayGroups || []));
    this.monitoredRegions = JSON.parse(JSON.stringify(config.monitoredRegions || []));
    this.profileRulesEnabled = config.profileRulesEnabled === true;
    this.normalizeProfileRules();
    this.stateSubscription = this.electronService.stateUpdateStream.subscribe((frameState: any) => {
      this.currentFrameState = frameState;
      this.syncProfileActiveStatesFromFrameState(frameState);
      this.applyLocalProfileRuleResults();
      this.scheduleViewRefresh();
    });
  }

  ngOnDestroy(): void {
    this.stateSubscription?.unsubscribe();
    this.electronService.setActivePage('');
  }

  canDeactivate(): boolean {
    if (!this.hasUnsavedChanges) {
      return true;
    }

    return window.confirm('You have unsaved changes in Profiles. Leave without saving?');
  }

  addProfile(): void {
    const profile = {
      id: crypto.randomUUID(),
      name: 'New Profile',
      active: true,
      rules: [],
    };
    this.profiles.push(profile);
    this.onProfilesChanged();
    setTimeout(() => {
      const input = document.querySelector(`[data-profile-name-id="${profile.id}"]`) as HTMLInputElement | null;
      if (!input) return;
      input.focus();
      input.select();
    }, 0);
  }

  deleteProfile(index: number): void {
    const [removedProfile] = this.profiles.splice(index, 1);
    if (removedProfile?.id) {
      for (const group of this.overlayGroups) {
        group.profileIds = (group.profileIds || []).filter((profileId: string) => profileId !== removedProfile.id);
      }
    }
    this.onProfilesChanged();
  }

  getProfileGroupCount(profileId: string): number {
    return this.overlayGroups.filter((group) => (group.profileIds || []).includes(profileId)).length;
  }

  hasProfileRules(profile: any): boolean {
    return (profile.rules || []).length > 0;
  }

  addProfileRule(profile: any): void {
    if (!Array.isArray(profile.rules)) {
      profile.rules = [];
    }
    profile.rules.push({
      id: crypto.randomUUID(),
      logicMode: 'AND',
      conditions: [{ monitoredRegionId: '', stateCalculationId: '', operator: 'equals', value: '', negate: false }],
      thenAction: 'activate',
      otherwiseAction: 'inactivate',
    });
    this.onProfilesChanged();
  }

  deleteProfileRule(profile: any, index: number): void {
    profile.rules.splice(index, 1);
    this.onProfilesChanged();
  }

  addProfileRuleCondition(rule: any): void {
    rule.conditions.push({ monitoredRegionId: '', stateCalculationId: '', operator: 'equals', value: '', negate: false });
    this.onProfilesChanged();
  }

  deleteProfileRuleCondition(rule: any, index: number): void {
    rule.conditions.splice(index, 1);
    this.onProfilesChanged();
  }

  onRegionSelectedForCondition(condition: any): void {
    const repeatedOnlyOperators = [
      'equalsAtLeastOnceAcrossRepeatedRegions',
      'equalsInEveryRepeatedRegion',
      'equalsAtLeastNTimesAcrossRepeatedRegions',
      'equalsInEverySelectedRepeatedRegion',
      'equalsAtLeastOnceInSelectedRepeatedRegions',
    ];
    if (!this.isRepeatingRegion(condition.monitoredRegionId) && repeatedOnlyOperators.includes(condition.operator)) {
      condition.operator = 'equals';
    }
    this.autofillConditionCalculationAndValue(condition);
    this.onProfilesChanged();
  }

  onCalculationSelectedForCondition(condition: any): void {
    this.autofillConditionValue(condition);
    this.onProfilesChanged();
  }

  getCalcsForRegion(regionId: string): any[] {
    const region = this.monitoredRegions.find((candidate) => candidate.id === regionId);
    return region?.stateCalculations || [];
  }

  isRepeatingRegion(regionId: string): boolean {
    const region = this.monitoredRegions.find((candidate) => candidate.id === regionId);
    if (!region?.repeat?.enabled) {
      return false;
    }

    const repeatsInX = region.repeat.x?.enabled === true && (region.repeat.x?.count ?? 1) > 1;
    const repeatsInY = region.repeat.y?.enabled === true && (region.repeat.y?.count ?? 1) > 1;
    return repeatsInX || repeatsInY;
  }

  getRepeatInstanceOptions(regionId: string): Array<{ key: string; label: string }> {
    const region = this.monitoredRegions.find((candidate: any) => candidate.id === regionId);
    if (!region?.repeat?.enabled) return [];
    const xCount = region.repeat.x?.enabled === true && (region.repeat.x?.count ?? 1) > 1 ? (region.repeat.x?.count ?? 1) : 1;
    const yCount = region.repeat.y?.enabled === true && (region.repeat.y?.count ?? 1) > 1 ? (region.repeat.y?.count ?? 1) : 1;
    const options: Array<{ key: string; label: string }> = [];
    for (let y = 0; y < yCount; y++) {
      for (let x = 0; x < xCount; x++) {
        const key = `${x}_${y}`;
        let label: string;
        if (x === 0 && y === 0) {
          label = 'Base';
        } else if (yCount === 1) {
          label = `X${x}`;
        } else if (xCount === 1) {
          label = `Y${y}`;
        } else {
          label = `X${x} Y${y}`;
        }
        options.push({ key, label });
      }
    }
    return options;
  }

  isRepeatInstanceSelected(condition: any, key: string): boolean {
    return (condition.selectedRepeatInstances || []).includes(key);
  }

  toggleRepeatInstance(condition: any, key: string): void {
    if (!condition.selectedRepeatInstances) condition.selectedRepeatInstances = [];
    const idx = condition.selectedRepeatInstances.indexOf(key);
    if (idx >= 0) condition.selectedRepeatInstances.splice(idx, 1);
    else condition.selectedRepeatInstances.push(key);
    this.onProfilesChanged();
  }

  getStateValuesForCalc(regionId: string, calcId: string): string[] {
    const region = this.monitoredRegions.find((candidate) => candidate.id === regionId);
    if (!region) return [];
    const calc = region.stateCalculations.find((candidate: any) => candidate.id === calcId);
    if (!calc) return [];
    const colorValues = (calc.colorStateMappings || []).map((mapping: any) => mapping.stateValue).filter((value: string) => value);
    const thresholdValues = (calc.colorThresholdMappings || []).map((mapping: any) => mapping.stateValue).filter((value: string) => value);
    const substringValues = (calc.substringMappings || []).map((mapping: any) => mapping.stateValue).filter((value: string) => value);
    const allValues = [...colorValues, ...thresholdValues, ...substringValues];
    if (calc.defaultStateValue && !allValues.includes(calc.defaultStateValue)) {
      allValues.push(calc.defaultStateValue);
    }
    return allValues;
  }

  getCalcType(regionId: string, calcId: string): string {
    const region = this.monitoredRegions.find((candidate) => candidate.id === regionId);
    if (!region) return '';
    const calc = region.stateCalculations.find((candidate: any) => candidate.id === calcId);
    return calc?.type || '';
  }

  private autofillConditionCalculationAndValue(condition: any): void {
    const firstCalc = this.getCalcsForRegion(condition.monitoredRegionId)[0];
    condition.stateCalculationId = firstCalc?.id || '';
    this.autofillConditionValue(condition);
  }

  private autofillConditionValue(condition: any): void {
    const firstValue = this.getStateValuesForCalc(condition.monitoredRegionId, condition.stateCalculationId)[0];
    condition.value = firstValue || '';
  }

  isConditionTrue(condition: any): boolean {
    if (!this.currentFrameState?.regionStates) {
      return false;
    }

    const regionState = this.currentFrameState.regionStates.find(
      (state: any) => state.monitoredRegionId === condition.monitoredRegionId,
    );
    if (!regionState) {
      return false;
    }

    const calcResult = regionState.calculationResults.find(
      (result: any) => result.stateCalculationId === condition.stateCalculationId,
    );
    if (!calcResult) {
      return false;
    }

    let conditionResult = this.evaluateConditionOperator(condition, calcResult, this.currentFrameState);
    if (condition.negate) {
      conditionResult = !conditionResult;
    }

    return conditionResult;
  }

  getProfileRuleResult(rule: any): 'Active' | 'Inactive' {
    const conditionsMatch = this.evaluateConditions(rule.conditions || [], rule.logicMode || 'AND');
    const action = conditionsMatch ? rule.thenAction : rule.otherwiseAction;
    return action === 'activate' ? 'Active' : 'Inactive';
  }

  async saveProfiles(): Promise<void> {
    const config = await this.electronService.loadConfig();
    this.applyLocalProfileRuleResults();
    this.applyProfileActivationToGroups();
    config.profiles = JSON.parse(JSON.stringify(this.profiles));
    config.profileRulesEnabled = this.profileRulesEnabled;
    config.overlayGroups = JSON.parse(JSON.stringify(this.overlayGroups));
    await this.electronService.saveConfig(config);
    this.hasUnsavedChanges = false;
  }

  onProfilesChanged(): void {
    this.applyLocalProfileRuleResults();
    this.hasUnsavedChanges = true;
  }

  onProfileRulesAutomationChanged(): void {
    this.applyLocalProfileRuleResults();
    this.hasUnsavedChanges = true;
  }

  private normalizeProfileRules(): void {
    for (const profile of this.profiles) {
      if (!Array.isArray(profile.rules)) {
        profile.rules = [];
      }
      for (const rule of profile.rules) {
        rule.logicMode = rule.logicMode || 'AND';
        rule.conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
        rule.thenAction = rule.thenAction || 'activate';
        rule.otherwiseAction = rule.otherwiseAction || 'inactivate';
      }
    }
  }

  private applyProfileActivationToGroups(): void {
    if (this.profiles.length === 0) {
      return;
    }

    const activeProfileIds = new Set(this.profiles.filter((profile) => profile.active).map((profile) => profile.id));
    for (const group of this.overlayGroups) {
      group.profileIds = Array.isArray(group.profileIds) ? group.profileIds : [];
      if (group.profileIds.length > 0) {
        group.enabled = group.profileIds.some((profileId: string) => activeProfileIds.has(profileId));
      }
    }
  }

  private syncProfileActiveStatesFromFrameState(frameState: any): void {
    if (!this.profileRulesEnabled || !Array.isArray(frameState?.profileStates)) {
      return;
    }

    const activeByProfileId = new Map(frameState.profileStates.map((profileState: any) => [profileState.id, profileState.active]));
    let changed = false;
    for (const profile of this.profiles) {
      if (!this.hasProfileRules(profile) || !activeByProfileId.has(profile.id)) {
        continue;
      }

      const nextActive = activeByProfileId.get(profile.id);
      if (profile.active !== nextActive) {
        profile.active = nextActive;
        changed = true;
      }
    }

    if (changed) {
      this.applyProfileActivationToGroups();
    }
  }

  private applyLocalProfileRuleResults(): void {
    if (!this.profileRulesEnabled) {
      return;
    }

    let changed = false;
    for (const profile of this.profiles) {
      if (!this.hasProfileRules(profile)) {
        continue;
      }

      let nextActive = profile.active;
      for (const rule of profile.rules || []) {
        nextActive = this.getProfileRuleResult(rule) === 'Active';
      }

      if (profile.active !== nextActive) {
        profile.active = nextActive;
        changed = true;
      }
    }

    if (changed) {
      this.applyProfileActivationToGroups();
    }
  }

  private evaluateConditions(conditions: any[], logicMode: string): boolean {
    if (!conditions || conditions.length === 0) {
      return true;
    }

    if (!this.currentFrameState?.regionStates) {
      return false;
    }

    for (const condition of conditions) {
      const conditionResult = this.isConditionTrue(condition);

      if (logicMode === 'OR' && conditionResult) {
        return true;
      }
      if (logicMode === 'AND' && !conditionResult) {
        return false;
      }
    }

    return logicMode === 'AND';
  }

  private evaluateConditionOperator(condition: any, calcResult: any, frameState: any): boolean {
    if (condition.operator === 'equals') {
      return calcResult.currentValue === condition.value;
    }

    if (condition.operator === 'notEquals') {
      return calcResult.currentValue !== condition.value;
    }

    const instanceStates = frameState?.regionInstanceStates || [];
    const matchingInstances = instanceStates.filter(
      (instanceState: any) => instanceState.monitoredRegionId === condition.monitoredRegionId,
    );
    if (matchingInstances.length === 0) {
      return false;
    }

    const matchingValues = matchingInstances.map((instanceState: any) =>
      instanceState.calculationResults.find(
        (instanceCalcResult: any) => instanceCalcResult.stateCalculationId === condition.stateCalculationId,
      )?.currentValue,
    );

    if (condition.operator === 'equalsAtLeastOnceAcrossRepeatedRegions') {
      return matchingValues.some((value: string | undefined) => value === condition.value);
    }

    if (condition.operator === 'equalsInEveryRepeatedRegion') {
      return matchingValues.every((value: string | undefined) => value === condition.value);
    }

    if (condition.operator === 'equalsAtLeastNTimesAcrossRepeatedRegions') {
      const minCount = condition.minimumCount ?? 1;
      return matchingValues.filter((value: string | undefined) => value === condition.value).length >= minCount;
    }

    if (condition.operator === 'equalsInEverySelectedRepeatedRegion' || condition.operator === 'equalsAtLeastOnceInSelectedRepeatedRegions') {
      const selectedKeys: string[] = condition.selectedRepeatInstances || [];
      const selectedInstances = matchingInstances.filter(
        (instanceState: any) => selectedKeys.includes(`${instanceState.repeatIndexX}_${instanceState.repeatIndexY}`),
      );
      if (selectedInstances.length === 0) return false;
      const selectedValues = selectedInstances.map((instanceState: any) =>
        instanceState.calculationResults.find(
          (r: any) => r.stateCalculationId === condition.stateCalculationId,
        )?.currentValue,
      );
      if (condition.operator === 'equalsInEverySelectedRepeatedRegion') {
        return selectedValues.every((value: string | undefined) => value === condition.value);
      }
      return selectedValues.some((value: string | undefined) => value === condition.value);
    }

    return true;
  }

  private scheduleViewRefresh(): void {
    if (this.viewRefreshScheduled) {
      return;
    }

    this.viewRefreshScheduled = true;
    requestAnimationFrame(() => {
      this.viewRefreshScheduled = false;
      this.changeDetectorRef.detectChanges();
    });
  }
}
