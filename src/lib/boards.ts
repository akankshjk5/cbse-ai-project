/**
 * Boards selectable in the "Create PPTX" form.
 *
 * Shared between the client dialog (render the options) and the server
 * action (validate the submitted value against the same list) so the two
 * never drift apart.
 */
export const INDIAN_BOARDS = [
  'CBSE',
  'ICSE/ISC',
  'NIOS',
  'IB',
  'IGCSE (Cambridge)',
  'Andhra Pradesh Board',
  'Arunachal Pradesh Board',
  'Assam Board (SEBA/AHSEC)',
  'Bihar Board (BSEB)',
  'Chhattisgarh Board (CGBSE)',
  'Delhi Board (DBSE)',
  'Goa Board (GBSHSE)',
  'Gujarat Board (GSEB)',
  'Haryana Board (BSEH)',
  'Himachal Pradesh Board (HPBOSE)',
  'Jharkhand Board (JAC)',
  'Karnataka Board (KSEEB)',
  'Kerala Board (SCERT/DHSE)',
  'Madhya Pradesh Board (MPBSE)',
  'Maharashtra Board (MSBSHSE)',
  'Manipur Board (BSEM/COHSEM)',
  'Meghalaya Board (MBOSE)',
  'Mizoram Board (MBSE)',
  'Nagaland Board (NBSE)',
  'Odisha Board (BSE/CHSE)',
  'Punjab Board (PSEB)',
  'Rajasthan Board (RBSE)',
  'Sikkim Board (SBOSE/SCERT)',
  'Tamil Nadu Board (TNBSE)',
  'Telangana Board (TSBIE/BSE)',
  'Tripura Board (TBSE)',
  'Uttar Pradesh Board (UPMSP)',
  'Uttarakhand Board (UBSE)',
  'West Bengal Board (WBBSE/WBCHSE)',
] as const;

export type IndianBoard = (typeof INDIAN_BOARDS)[number];

export const DEFAULT_BOARD: IndianBoard = 'CBSE';

export function isValidBoard(value: string): value is IndianBoard {
  return (INDIAN_BOARDS as readonly string[]).includes(value);
}
