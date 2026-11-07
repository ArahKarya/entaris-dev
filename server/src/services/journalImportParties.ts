// Journal import (E7-R9b), party part: the partyCode column is a party id or an exact party name
// (case-insensitive). A name two parties share is refused on its row (owner decision #4), never
// guessed. After resolution each line goes through the one party rule ('strict', partyRules.ts):
// a receivable/payable/deposit line needs its party, any other line refuses one. Problems are
// reported per sheet row so the all-or-nothing import shows every bad row at once.
import type { PartyType, Prisma } from '@prisma/client';
import { loadPartyRoleMap, partyLineProblem, PARTY_NOT_FOUND, PARTY_AMBIGUOUS_NAME, type PartyProblemCode } from './ledger/partyRules';
import type { CheckedGroup, ImportRowError } from './journalImport';

type Tx = Prisma.TransactionClient;

export interface PartyLite {
  id: string;
  name: string;
  partyType: PartyType;
}

export type PartyMatch =
  | { ok: true; party: PartyLite }
  | { ok: false; message: string; code: PartyProblemCode };

const nameKey = (value: string): string => value.trim().toLowerCase();

/** An id wins over a name; a name must be unique (ignoring case) among `candidates`. */
export function matchPartyCode(code: string, candidates: readonly PartyLite[]): PartyMatch {
  const byId = candidates.find((p) => p.id === code);
  if (byId) return { ok: true, party: byId };
  const named = candidates.filter((p) => nameKey(p.name) === nameKey(code));
  if (named.length === 1) return { ok: true, party: named[0] };
  if (named.length > 1) {
    return { ok: false, message: `Nama pihak "${code}" dipakai lebih dari satu pihak; isi kolom "partyCode" dengan ID pihak.`, code: PARTY_AMBIGUOUS_NAME };
  }
  return { ok: false, code: PARTY_NOT_FOUND, message: `Pihak "${code}" tidak ditemukan; isi kolom "partyCode" dengan nama persis atau ID pihak.` };
}

/** The parties any of the codes could name, in one query. */
async function loadCandidates(tx: Tx, codes: readonly string[]): Promise<PartyLite[]> {
  if (codes.length === 0) return [];
  return tx.party.findMany({
    where: {
      OR: [
        { id: { in: [...codes] } },
        ...codes.map((code) => ({ name: { equals: code.trim(), mode: 'insensitive' as const } })),
      ],
    },
    select: { id: true, name: true, partyType: true },
  });
}

/**
 * Replaces each line's raw partyCode (carried in `partyId`) with the party id and checks the party
 * rule per line. `accountIds` maps the account number carried in `accountId` to the account id.
 */
export async function resolveImportParties(
  tx: Tx,
  groups: readonly CheckedGroup[],
  accountIds: ReadonlyMap<string, string>,
): Promise<{ groups: CheckedGroup[]; errors: ImportRowError[] }> {
  const codes = [...new Set(groups.flatMap((g) => g.lines.map((l) => l.partyId)).filter((c): c is string => !!c))];
  const candidates = await loadCandidates(tx, codes);
  const matches = new Map(codes.map((code) => [code, matchPartyCode(code, candidates)]));

  const knownAccountIds = [...new Set(groups.flatMap((g) => g.lines.map((l) => accountIds.get(l.accountId))).filter((id): id is string => !!id))];
  const roles = await loadPartyRoleMap(tx, knownAccountIds);

  const errors: ImportRowError[] = [];
  const resolvedGroups = groups.map((checked) => {
    const lines = checked.lines.map((line, index) => {
      const rowNum = checked.group.items[index].rowNum;
      const match = line.partyId ? matches.get(line.partyId)! : null;
      if (match && !match.ok) {
        errors.push({ row: rowNum, message: match.message, code: match.code });
        return { ...line, partyId: null };
      }
      const party = match?.ok ? match.party : null;
      const accountId = accountIds.get(line.accountId);
      // An unknown account is already an error on this row.
      if (accountId) {
        const problem = partyLineProblem({ partyId: party?.id ?? null, partyType: party?.partyType ?? null }, roles.get(accountId), 'strict');
        if (problem) errors.push({ row: rowNum, message: problem.message, code: problem.code });
      }
      return { ...line, partyId: party?.id ?? null };
    });
    return { ...checked, lines };
  });
  return { groups: resolvedGroups, errors };
}
