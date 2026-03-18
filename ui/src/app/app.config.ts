import { ApplicationConfig } from '@angular/core';
import { provideRouter, Routes } from '@angular/router';

import { CapturePreviewComponent } from './components/capture-preview/capture-preview.component';
import { MonitoredRegionsComponent } from './components/monitored-regions/monitored-regions.component';
import { OverlayGroupsComponent } from './components/overlay-groups/overlay-groups.component';
import { SettingsComponent } from './components/settings/settings.component';
import { pendingChangesGuard } from './guards/pending-changes.guard';

const routes: Routes = [
  { path: '', redirectTo: 'capture', pathMatch: 'full' },
  { path: 'capture', component: CapturePreviewComponent },
  { path: 'regions', component: MonitoredRegionsComponent, canDeactivate: [pendingChangesGuard] },
  { path: 'overlays', component: OverlayGroupsComponent, canDeactivate: [pendingChangesGuard] },
  { path: 'settings', component: SettingsComponent },
];

export const appConfig: ApplicationConfig = {
  providers: [provideRouter(routes)],
};
