/**
 * P8b multi-time-signature: the METER paragraph in the system prompt and
 * the meter-aware ambient preamble.
 *
 * Byte-stability contract: an all-4/4 project renders a preamble
 * byte-identical to a host with NO meter source at all (db_query missing /
 * failing / returning 4/4 rows) — meters appear ONLY when non-4/4.
 */
import { DEFAULT_SYSTEM_PROMPT } from '../plugin';
import { buildAmbientContext, _resetAmbientCacheForTests } from '../panel-tools';

// ---------------------------------------------------------------------------
// System prompt — the meter contract paragraph (deliberate 2.5.0 change)
// ---------------------------------------------------------------------------

describe('DEFAULT_SYSTEM_PROMPT — meter vocabulary', () => {
  it('defines the time-signature contract', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Time signature \(meter\):/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/"N\/D"/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/BPM ALWAYS counts QUARTER notes/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/numerator×4\/denominator quarter notes/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/numerator slots per bar \(one per denominator beat\)/);
  });

  it('names the tools and the contract-lock rule', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/scene_set_time_signature/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/locks together with the contract once the scene has tracks/);
  });

  it('states the cross-meter transition rule (TARGET meter) and plugin gating', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/DIFFERENT meters/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/authored in the TARGET scene's meter/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/don't declare support for a scene's meter appear disabled/);
  });
});

// ---------------------------------------------------------------------------
// Ambient preamble — meter lines
// ---------------------------------------------------------------------------

const ACTIVE = 'scene-aaaa1111-2222-3333-4444-555555555555';
const OTHER = 'scene-bbbb2222-2222-3333-4444-555555555555';
const PROJECT_ID = 'proj-12345678-aaaa-bbbb-cccc-dddddddddddd';

const INSPECT_CHANGES = {
  project: { id: PROJECT_ID, name: 'Demo', activeSceneId: ACTIVE },
  musical_context: { key: 'A minor', bpm: 120, chord_progression: 'Am - F - C - G' },
  scenes: [
    { id: ACTIVE, name: 'Verse 1', displayName: 'Verse 1' },
    { id: OTHER, name: 'Chorus', displayName: 'Chorus' },
  ],
  tracks: [],
};

/**
 * Host mock dispatching on tool name: sas_inspect_project → the fixture
 * payload; db_query → the given rows (or a failure / legacy inspect-shaped
 * reply, to model hosts without db_query).
 */
function makeMeterHost(
  dbQuery:
    | { kind: 'rows'; rows: Array<{ id: string; time_signature: string | null }> }
    | { kind: 'throws' }
    | { kind: 'legacy-shape' }
) {
  return {
    executeAppTool: jest.fn(async (tool: string) => {
      if (tool === 'db_query') {
        if (dbQuery.kind === 'throws') throw new Error('no db_query on this host');
        if (dbQuery.kind === 'rows') {
          return {
            success: true,
            action: 'db_query',
            message: 'ok',
            data: {
              success: true,
              action: 'db_query',
              changes: {
                rows: dbQuery.rows,
                rowCount: dbQuery.rows.length,
                columns: ['id', 'time_signature'],
                truncated: false,
              },
            },
          };
        }
        // legacy-shape: pre-meter mocks answered every tool with the inspect
        // payload — the parser must treat that as "no meter data".
      }
      return {
        success: true,
        action: 'sas_inspect_project',
        message: 'ok',
        data: { success: true, action: 'sas_inspect_project', changes: INSPECT_CHANGES },
      };
    }),
    getActiveSceneId: jest.fn(() => ACTIVE),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const build = (host: any): Promise<string> => {
  _resetAmbientCacheForTests(host);
  return buildAmbientContext(host);
};

describe('buildAmbientContext — meter lines', () => {
  it('all-4/4 projects render byte-identical to hosts with no meter source', async () => {
    const all44 = await build(
      makeMeterHost({
        kind: 'rows',
        rows: [
          { id: ACTIVE, time_signature: '4/4' },
          { id: OTHER, time_signature: null }, // pre-078 NULL reads as 4/4
        ],
      })
    );
    const noDbQuery = await build(makeMeterHost({ kind: 'throws' }));
    const legacyShape = await build(makeMeterHost({ kind: 'legacy-shape' }));
    expect(all44).toBe(noDbQuery);
    expect(all44).toBe(legacyShape);
    expect(all44).not.toContain('time signature');
    expect(all44).not.toContain('meter=');
    expect(all44).toContain('Active scene contract: key=A minor bpm=120 chords=Am - F - C - G');
  });

  it('non-4/4 scenes get a meter suffix; the active contract line derives qn/bar', async () => {
    const text = await build(
      makeMeterHost({
        kind: 'rows',
        rows: [
          { id: ACTIVE, time_signature: '7/8' },
          { id: OTHER, time_signature: '6/8' },
        ],
      })
    );
    // Active contract: meter + derived quarter notes per bar (7/8 → 3.5).
    expect(text).toContain(
      'Active scene contract: key=A minor bpm=120 meter=7/8 (3.5 quarter notes/bar; BPM counts quarter notes) chords=Am - F - C - G'
    );
    // Scene table: suffix on each non-4/4 line.
    expect(text).toMatch(/"Verse 1"\s+→\s+id = scene-aaaa1111[^\n]*\[time signature 7\/8\]/);
    expect(text).toMatch(/"Chorus"\s+→\s+id = scene-bbbb2222[^\n]*\[time signature 6\/8\]/);
  });

  it('a mixed project marks only the non-4/4 scene', async () => {
    const text = await build(
      makeMeterHost({
        kind: 'rows',
        rows: [
          { id: ACTIVE, time_signature: '4/4' },
          { id: OTHER, time_signature: '3/4' },
        ],
      })
    );
    expect(text).not.toContain('meter='); // active is 4/4 — contract line untouched
    const verseLine = text.split('\n').find((l) => l.includes('"Verse 1"  →'));
    expect(verseLine).toBeDefined();
    expect(verseLine).not.toContain('time signature');
    expect(text).toMatch(/"Chorus"[^\n]*\[time signature 3\/4\]/);
  });
});
