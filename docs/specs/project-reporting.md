# Project and cost-center reporting

Bills can carry private project and cost-center references. These remain encrypted in storage, survive recurring draft creation and appear in authorized accounting exports. They are references on business records, not a fixed configuration catalog.

The project report groups actual reconciled payment costs and remaining maximum budgets by those references. A second view groups the same records by cost center. CSV rows identify their dimension; project and cost-center rows describe overlapping records and must not be added together.

Confirmed incoming cash remains unclassified until an authorized financial approver reviews it. The reviewer assigns a project, optional cost center and classification: earned revenue, client deposit or internal transfer. Each classification requires evidence, the current record version and a funding leg backed by final credited NEAR token receipts. Changes preserve encrypted history and reject stale edits.

Client deposits and internal transfers never increase earned receipts. Active client earmarks linked to a funding leg prevent it from being classified as earned. Unattributed client earmarks hold earned classifications until their provenance is resolved. These checks also apply to the displayed report if a hold is added after classification.

The classified cash result is earned receipts less reconciled payment costs. It is not a profit measure or a statement that every contractual obligation has been satisfied. Client principal, held classifications, open budgets and unresolved payments remain visible separately. Business setoff discharges debt without creating a token receipt, cash income or payment cost.

The interface is in Activity & reports. Reporting requires financial read and report permissions; classification also requires payment approval permission. Local checks cover final-receipt requirements, stale versions, encrypted evidence, company scoping, client earmarks and spreadsheet-safe CSV output. Real funding evidence remains an external integration gate.
