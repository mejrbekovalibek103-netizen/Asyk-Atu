import { describe, expect, it } from 'vitest';
import sql from '../../../supabase/competitive.sql?raw';
import { STAKE_LAYOUT_IDS } from './matchLayouts';

/**
 * База пускает в матч только коны из private.comp_layout_ids() (supabase/competitive.sql), а сервер и браузер
 * строят кон из STAKE_LAYOUT_IDS. Разойдутся списки — матч на новом коне нельзя будет создать или бросить.
 */
describe('коны «на асыки»: список в базе совпадает с кодом', () => {
  it('private.comp_layout_ids() = STAKE_LAYOUT_IDS', () => {
    const m = sql.match(/function private\.comp_layout_ids\(\)[\s\S]*?array\[([^\]]*)\]/);
    expect(m, 'в competitive.sql нет private.comp_layout_ids()').not.toBeNull();
    const ids = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(ids).toEqual([...STAKE_LAYOUT_IDS]);
  });
});
