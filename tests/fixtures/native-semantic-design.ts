export function semanticDesign(recordFields: string[] = []) {
  return {
    schemaVersion: 1,
    sectionOrder: ['summary', 'composer', 'records'],
    layout: {fields: 'paired-short', records: 'cards'},
    headings: {records: 'Saved items', composer: 'New item'},
    recordFields,
  };
}
