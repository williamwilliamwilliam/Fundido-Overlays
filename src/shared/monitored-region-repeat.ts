import {
  MonitoredRegion,
  MonitoredRegionRepeatConfig,
  RuntimeMonitoredRegion,
} from './models/domain';

export function createDefaultMonitoredRegionRepeatConfig(): MonitoredRegionRepeatConfig {
  return {
    enabled: false,
    x: {
      enabled: false,
      every: 0,
      count: 1,
    },
    y: {
      enabled: false,
      every: 0,
      count: 1,
    },
  };
}

export function normalizeMonitoredRegionRepeatConfig(region: MonitoredRegion | any): void {
  const defaults = createDefaultMonitoredRegionRepeatConfig();
  const repeat = region.repeat || {};

  region.repeat = {
    enabled: repeat.enabled === true,
    x: {
      enabled: repeat.x?.enabled === true,
      every: Number.isFinite(repeat.x?.every) ? repeat.x.every : defaults.x.every,
      count: normalizeRepeatCount(repeat.x?.count),
    },
    y: {
      enabled: repeat.y?.enabled === true,
      every: Number.isFinite(repeat.y?.every) ? repeat.y.every : defaults.y.every,
      count: normalizeRepeatCount(repeat.y?.count),
    },
  };
}

export function getRuntimeMonitoredRegions(regions: MonitoredRegion[] | any[]): RuntimeMonitoredRegion[] {
  const runtimeRegions: RuntimeMonitoredRegion[] = [];

  for (const region of regions) {
    normalizeMonitoredRegionRepeatConfig(region);

    const repeat = region.repeat;
    const xCount = repeat.enabled && repeat.x.enabled ? normalizeRepeatCount(repeat.x.count) : 1;
    const yCount = repeat.enabled && repeat.y.enabled ? normalizeRepeatCount(repeat.y.count) : 1;
    let instanceIndex = 0;

    for (let repeatIndexY = 0; repeatIndexY < yCount; repeatIndexY += 1) {
      for (let repeatIndexX = 0; repeatIndexX < xCount; repeatIndexX += 1) {
        runtimeRegions.push({
          ...region,
          id: `${region.id}__repeat_${repeatIndexX}_${repeatIndexY}`,
          sourceMonitoredRegionId: region.id,
          instanceIndex,
          repeatIndexX,
          repeatIndexY,
          bounds: {
            x: region.bounds.x + (repeat.enabled && repeat.x.enabled ? repeat.x.every * repeatIndexX : 0),
            y: region.bounds.y + (repeat.enabled && repeat.y.enabled ? repeat.y.every * repeatIndexY : 0),
            width: region.bounds.width,
            height: region.bounds.height,
          },
        });
        instanceIndex += 1;
      }
    }
  }

  return runtimeRegions;
}

export function getMonitoredRegionInstanceCount(region: MonitoredRegion | any): number {
  normalizeMonitoredRegionRepeatConfig(region);
  if (!region.repeat.enabled) {
    return 1;
  }

  const xCount = region.repeat.x.enabled ? normalizeRepeatCount(region.repeat.x.count) : 1;
  const yCount = region.repeat.y.enabled ? normalizeRepeatCount(region.repeat.y.count) : 1;
  return xCount * yCount;
}

function normalizeRepeatCount(value: unknown): number {
  if (!Number.isFinite(value as number)) {
    return 1;
  }

  return Math.max(1, Math.floor(value as number));
}
