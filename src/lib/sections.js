'use strict';

const { norm } = require('./text');

/**
 * Canonical section catalogue for the PepsiCo PI/PO "Interface Specification PO Technical Document".
 * Headings are matched by their (anchored) title because auto-numbering means the section number is
 * frequently NOT part of the paragraph text.
 */
const SECTION_DEFS = [
  { key: 'docinfo', re: /^document information$/, level: 1 },
  { key: 'doclocation', re: /^document location$/, level: 2 },
  { key: 'revision', re: /^revision history$/, level: 2 },
  { key: 'approval', re: /^design authority approval details$/, level: 2 },
  { key: 'general', re: /^general information$/, level: 1 },
  { key: 'hl_design', re: /^high[- ]level technical design$/, level: 1 },
  { key: 'business_req', re: /^high[- ]level business requirements?$/, level: 2 },
  { key: 'volume', re: /^volume and frequency$/, level: 3 },
  { key: 'system_diagram', re: /^high[- ]level system diagram$/, level: 2 },
  { key: 'solution_overview', re: /^technical solution overview/, level: 2 },
  { key: 'tech_details', re: /^technical details( \/ process flows)?$/, level: 1 },
  { key: 'design_diagram', re: /^technical design diagram/, level: 2 },
  { key: 'assumptions', re: /^technical assumptions$/, level: 2 },
  { key: 'dependencies', re: /^technical dependencies$/, level: 2 },
  { key: 'ale', re: /^ale configuration$/, level: 2 },
  { key: 'mapping', re: /^mapping$/, level: 1, needsHeadingStyle: true },
  { key: 'source_structure', re: /^source structure layout$/, level: 2 },
  { key: 'target_structure', re: /^target structure layout$/, level: 2 },
  { key: 'data_mapping', re: /^data mapping$/, level: 2 },
  { key: 'custom_functions', re: /^custom functions and modules$/, level: 2 },
  { key: 'translation', re: /^translation rules$/, level: 2 },
  { key: 'value_mapping', re: /^value mapping$/, level: 2 },
  { key: 'xref', re: /^cross[- ]referencing$/, level: 2 },
  { key: 'object_inventory', re: /^object inventory$/, level: 1 },
  { key: 'sld', re: /^system landscape directory$/, level: 2 },
  { key: 'sld_product', re: /^product$/, level: 3, needsHeadingStyle: true },
  { key: 'sld_swcv', re: /^swcv$/, level: 3 },
  { key: 'technical_system', re: /^technical systems?$/, level: 3 },
  { key: 'business_system', re: /^business systems?$/, level: 3 },
  { key: 'esr', re: /^enterprise service repository$/, level: 2 },
  { key: 'data_types', re: /^data types?\(?s?\)? for/, level: 3 },
  { key: 'message_types', re: /^message types?\(?s?\)? for/, level: 3 },
  { key: 'external_def', re: /^external definitions?/, level: 3 },
  { key: 'sender_interface', re: /^sender interfaces?/, level: 3 },
  { key: 'receiver_interface', re: /^receiver interfaces?/, level: 3 },
  { key: 'operation_mapping', re: /^operation mappings?/, level: 3 },
  { key: 'message_mapping', re: /^message mappings?/, level: 3 },
  { key: 'imported_archive', re: /^imported archives?/, level: 3 },
  { key: 'function_libraries', re: /^function libraries/, level: 3 },
  { key: 'imported_objects', re: /^imported objects/, level: 3 },
  { key: 'pi_scenarios', re: /^process integration scenarios/, level: 3 },
  { key: 'actions', re: /^actions\b/, level: 3 },
  { key: 'id', re: /^integration directory$/, level: 2 },
  { key: 'config_scenario', re: /^configuration scenarios?/, level: 3 },
  { key: 'sender_service', re: /^sender service/, level: 3 },
  { key: 'sender_adapter', re: /^sender adapters?/, level: 3 },
  { key: 'receiver_service', re: /^receiver service/, level: 3 },
  { key: 'receiver_adapter', re: /^receiver adapters?/, level: 3 },
  { key: 'ico', re: /^integrated configurations?/, level: 3 },
  { key: 'additional', re: /^additional information and attachments$/, level: 1 },
  { key: 'error_handling', re: /^error handling and monitoring$/, level: 1 },
  { key: 'alert_rules', re: /^alert rules$/, level: 2 },
  { key: 'transport', re: /^transport history$/, level: 1 },
  { key: 'utp', re: /^unit test plan$/, level: 1 }
];

const LABELS = {
  docinfo: 'Document Information',
  doclocation: 'Document Location',
  revision: 'Revision History',
  approval: 'Design Authority Approval',
  general: '1. General Information',
  hl_design: '2. High Level Technical Design',
  business_req: '2.1 High Level Business Requirement',
  volume: '2.1.1 Volume and Frequency',
  system_diagram: '2.2 High Level System Diagram',
  solution_overview: '2.3 Technical Solution Overview',
  tech_details: '3. Technical Details / Process Flows',
  design_diagram: '3.1 Technical Design Diagram / Process Flow',
  assumptions: '3.2 Technical Assumptions',
  dependencies: '3.3 Technical Dependencies',
  ale: '3.4 ALE Configuration',
  mapping: '4. Mapping',
  source_structure: '4.1 Source Structure Layout',
  target_structure: '4.2 Target Structure Layout',
  data_mapping: '4.3 Data Mapping',
  custom_functions: '4.4 Custom Functions and Modules',
  translation: '4.5 Translation Rules',
  value_mapping: '4.6 Value Mapping',
  xref: '4.7 Cross Referencing',
  object_inventory: '5. Object Inventory',
  sld: '5.1 System Landscape Directory',
  sld_product: '5.1.1 Product',
  sld_swcv: '5.1.2 SWCV',
  technical_system: '5.1.3 Technical System',
  business_system: '5.1.4 Business System',
  esr: '5.2 Enterprise Service Repository',
  data_types: '5.2.1 Data Types',
  message_types: '5.2.2 Message Types',
  external_def: '5.2.3 External Definition',
  sender_interface: '5.2.4 Sender Interface',
  receiver_interface: '5.2.5 Receiver Interface',
  operation_mapping: '5.2.6 Operation Mapping',
  message_mapping: '5.2.7 Message Mapping',
  imported_archive: '5.2.8 Imported Archive',
  function_libraries: '5.2.9 Function Libraries',
  imported_objects: '5.2.10 Imported Objects',
  pi_scenarios: '5.2.11 Process Integration Scenarios',
  actions: '5.2.12 Actions',
  id: '5.3 Integration Directory',
  config_scenario: '5.3.1 Configuration Scenario',
  sender_service: '5.3.2 Sender Service / System / Party',
  sender_adapter: '5.3.3 Sender Adapter',
  receiver_service: '5.3.4 Receiver Service / System / Party',
  receiver_adapter: '5.3.5 Receiver Adapter',
  ico: '5.3.6 Integrated Configuration',
  additional: '6. Additional Information and Attachments',
  error_handling: '7. Error Handling and Monitoring',
  alert_rules: '7.1 Alert Rules',
  transport: '8. Transport History',
  utp: '9. Unit Test Plan',
  cover: 'Cover page'
};

/**
 * Returns {key, label} when the paragraph is a recognised section heading, else null.
 * Table-of-contents entries (tab + page number) are ignored.
 */
function classifyHeading(rawText, style, hadTab) {
  if (!rawText) return null;
  if (hadTab && /\s\d{1,3}\s*$/.test(rawText)) return null; // TOC line
  let t = norm(rawText);
  if (!t || t.length > 70) return null;
  t = t.replace(/^\d+(?:\.\d+){0,3}\.?\s*/, '').replace(/[:\s]+$/, '');
  const low = t.toLowerCase();
  if (!low) return null;
  const isHeadingStyle = /^heading[1-6]$/i.test(style || '');
  const hadNumber = /^\s*\d+(?:\.\d+){0,3}\.?\s+\S/.test(norm(rawText));
  for (const d of SECTION_DEFS) {
    if (d.re.test(low)) {
      if (d.needsHeadingStyle && !isHeadingStyle && !hadNumber) return null;
      return { key: d.key, label: LABELS[d.key] || t, level: d.level };
    }
  }
  return null;
}

module.exports = { classifyHeading, LABELS };
