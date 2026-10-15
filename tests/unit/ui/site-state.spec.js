// Состояние сайта в popup (К9): needsAccess — только когда перехват по настройкам активен, а доступа к сайту нет.
import { describe, it, expect } from 'vitest';
import { siteState } from '../../../src/ui/components/site-state.js';
import { defaultSettings } from '../../../src/core/settings.js';

const on = { ...defaultSettings(), interceptEnabled: true, siteMode: 'allowlist', allowlist: ['https://claude.ai'], blocklist: [] };

describe('siteState: доступ к сайту', () => {
  it('on + granted:false → needsAccess; granted:true или не задан → on', () => {
    expect(siteState(on, 'https://claude.ai/chat/1', { granted: false })).toEqual({ state: 'needsAccess', host: 'claude.ai', origin: 'https://claude.ai' });
    expect(siteState(on, 'https://claude.ai/chat/1', { granted: true }).state).toBe('on');
    expect(siteState(on, 'https://claude.ai/chat/1').state).toBe('on'); // бейдж не знает о разрешениях
    expect(siteState(on, 'https://claude.ai/chat/1', {}).state).toBe('on');
  });

  it('в остальных состояниях granted:false ничего не меняет', () => {
    const g = { granted: false };
    expect(siteState(on, 'https://example.com/', g).state).toBe('notListed');
    expect(siteState({ ...on, blocklist: ['https://claude.ai'] }, 'https://claude.ai/', g).state).toBe('blocked');
    expect(siteState(defaultSettings(), 'https://claude.ai/', g).state).toBe('off');
    expect(siteState(on, 'chrome://extensions', g).state).toBe('unsupported');
  });

  it('режим all без доступа к сайту → needsAccess', () => {
    expect(siteState({ ...on, siteMode: 'all' }, 'https://mail.example.com/', { granted: false }).state).toBe('needsAccess');
  });
});
