export function semanticDesign(recordFields: string[] = []) {
  return {
    schemaVersion: 1,
    sectionOrder: ['summary', 'records', 'composer'],
    layout: {fields: 'paired-short', records: 'cards'},
    headings: {records: 'Saved items', composer: 'New item'},
    fieldLabels: {}, recordFields,
  };
}
