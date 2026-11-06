import { describe, it, expect } from 'vitest';
import { matchPartyCode, type PartyLite } from '../journalImportParties';

const p = (id: string, name: string): PartyLite => ({ id, name, partyType: 'Customer' });

describe('matchPartyCode', () => {
  const parties = [p('id-1', 'PT Maju'), p('id-2', 'CV Jaya'), p('id-3', 'cv jaya')];

  it('matches an id', () => {
    expect(matchPartyCode('id-1', parties)).toEqual({ ok: true, party: parties[0] });
  });

  it('matches an exact name ignoring case and surrounding spaces', () => {
    expect(matchPartyCode(' pt maju ', parties)).toEqual({ ok: true, party: parties[0] });
  });

  it('an id wins over a shared name', () => {
    expect(matchPartyCode('id-2', parties)).toEqual({ ok: true, party: parties[1] });
  });

  it('refuses a name two parties share', () => {
    expect(matchPartyCode('CV Jaya', parties)).toMatchObject({ ok: false, code: 'PARTY_AMBIGUOUS_NAME' });
  });

  it('refuses an unknown party', () => {
    expect(matchPartyCode('Nobody', parties)).toMatchObject({ ok: false, code: 'PARTY_NOT_FOUND' });
  });
});
