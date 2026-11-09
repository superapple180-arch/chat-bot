import path from 'node:path';

export function validateGuardianReport(report, expectedFiles) {
  const found = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.total_incidents > 0 || value.total_occurrences > 0 || Array.isArray(value.errors) && value.errors.length || Array.isArray(value.incidents) && value.incidents.length) throw Error('GITGUARDIAN_FINDING_OR_ERROR');
    if (Array.isArray(value.entities_with_incidents)) for (const entity of value.entities_with_incidents) {
      if (typeof entity.filename !== 'string') throw Error('GITGUARDIAN_INVALID_REPORT');
      found.push(path.posix.basename(entity.filename.replaceAll('\\', '/')));
    }
    for (const nested of Object.values(value)) if (nested && typeof nested === 'object') Array.isArray(nested) ? nested.forEach(visit) : visit(nested);
  }
  if (!report || typeof report !== 'object' || typeof report.type !== 'string' || report.total_incidents !== 0) throw Error('GITGUARDIAN_INVALID_REPORT');
  visit(report);
  if (expectedFiles && (new Set(found).size !== found.length || found.length !== expectedFiles.length || expectedFiles.some(file => !found.includes(file)))) throw Error('GITGUARDIAN_INCOMPLETE_COVERAGE');
}
