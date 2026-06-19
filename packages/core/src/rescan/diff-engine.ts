import type {
  SiteDescriptor,
  PageDescriptor,
  FormDescriptor,
  ButtonDescriptor,
  LinkDescriptor,
  SiteChangeEntry,
  RescanResult,
  SelectorSet,
} from '../types/site.js';

/**
 * Compare two SiteDescriptors and produce a structured diff of changes.
 */
export function diffSiteDescriptors(
  oldSite: SiteDescriptor,
  newSite: SiteDescriptor,
): RescanResult {
  const changes: SiteChangeEntry[] = [];
  const brokenSelectors: RescanResult['brokenSelectors'] = [];
  const now = new Date().toISOString();

  const oldPagesByUrl = new Map(oldSite.pages.map((p) => [p.url, p]));
  const newPagesByUrl = new Map(newSite.pages.map((p) => [p.url, p]));

  // Detect added pages
  for (const [url, page] of newPagesByUrl) {
    if (!oldPagesByUrl.has(url)) {
      changes.push({
        changeType: 'added',
        elementType: 'page',
        elementId: page.pageId,
        pageId: page.pageId,
        description: `Page added: ${url}`,
        timestamp: now,
        newValue: url,
      });
    }
  }

  // Detect removed pages
  for (const [url, page] of oldPagesByUrl) {
    if (!newPagesByUrl.has(url)) {
      changes.push({
        changeType: 'removed',
        elementType: 'page',
        elementId: page.pageId,
        pageId: page.pageId,
        description: `Page removed: ${url}`,
        timestamp: now,
        oldValue: url,
      });
    }
  }

  // Compare matching pages
  for (const [url, oldPage] of oldPagesByUrl) {
    const newPage = newPagesByUrl.get(url);
    if (!newPage) continue;

    diffForms(oldPage, newPage, changes, brokenSelectors, now);
    diffButtons(oldPage, newPage, changes, brokenSelectors, now);
    diffLinks(oldPage, newPage, changes, brokenSelectors, now);
  }

  const newVersion = oldSite.version + 1;
  const updatedSite: SiteDescriptor = {
    ...newSite,
    version: newVersion,
  };

  return {
    previousVersion: oldSite.version,
    newVersion,
    changes,
    brokenSelectors,
    newSiteDescriptor: updatedSite,
    timestamp: now,
  };
}

function diffForms(
  oldPage: PageDescriptor,
  newPage: PageDescriptor,
  changes: SiteChangeEntry[],
  brokenSelectors: RescanResult['brokenSelectors'],
  timestamp: string,
): void {
  const oldFormsById = new Map(oldPage.forms.map((f) => [f.formId, f]));
  const newFormsById = new Map(newPage.forms.map((f) => [f.formId, f]));

  for (const [id, form] of newFormsById) {
    if (!oldFormsById.has(id)) {
      changes.push({
        changeType: 'added',
        elementType: 'form',
        elementId: id,
        pageId: newPage.pageId,
        description: `Form added: ${form.semanticName ?? id}`,
        timestamp,
        newValue: form.semanticName,
      });
    }
  }

  for (const [id, form] of oldFormsById) {
    if (!newFormsById.has(id)) {
      changes.push({
        changeType: 'removed',
        elementType: 'form',
        elementId: id,
        pageId: oldPage.pageId,
        description: `Form removed: ${form.semanticName ?? id}`,
        timestamp,
        oldValue: form.semanticName,
      });
    }
  }

  for (const [id, oldForm] of oldFormsById) {
    const newForm = newFormsById.get(id);
    if (!newForm) continue;

    // Check for field changes
    diffFormFields(oldForm, newForm, oldPage.pageId, changes, timestamp);

    // Check for broken selectors
    if (oldForm.selector.primary !== newForm.selector.primary) {
      if (newForm.selector.confidence < 0.5) {
        brokenSelectors.push({
          toolName: newForm.semanticName ?? id,
          selector: oldForm.selector,
        });
        changes.push({
          changeType: 'selector-broken',
          elementType: 'form',
          elementId: id,
          pageId: oldPage.pageId,
          description: `Form selector changed with low confidence: ${oldForm.selector.primary}`,
          timestamp,
          oldValue: oldForm.selector.primary,
          newValue: newForm.selector.primary,
        });
      } else {
        changes.push({
          changeType: 'modified',
          elementType: 'form',
          elementId: id,
          pageId: oldPage.pageId,
          description: `Form selector updated: ${oldForm.selector.primary} → ${newForm.selector.primary}`,
          timestamp,
          oldValue: oldForm.selector.primary,
          newValue: newForm.selector.primary,
        });
      }
    }
  }
}

function diffFormFields(
  oldForm: FormDescriptor,
  newForm: FormDescriptor,
  pageId: string,
  changes: SiteChangeEntry[],
  timestamp: string,
): void {
  const oldFieldsByName = new Map(oldForm.fields.map((f) => [f.name, f]));
  const newFieldsByName = new Map(newForm.fields.map((f) => [f.name, f]));

  for (const [name] of newFieldsByName) {
    if (!oldFieldsByName.has(name)) {
      changes.push({
        changeType: 'added',
        elementType: 'field',
        elementId: `${oldForm.formId}:${name}`,
        pageId,
        description: `Field added to form ${oldForm.semanticName ?? oldForm.formId}: ${name}`,
        timestamp,
        newValue: name,
      });
    }
  }

  for (const [name] of oldFieldsByName) {
    if (!newFieldsByName.has(name)) {
      changes.push({
        changeType: 'removed',
        elementType: 'field',
        elementId: `${oldForm.formId}:${name}`,
        pageId,
        description: `Field removed from form ${oldForm.semanticName ?? oldForm.formId}: ${name}`,
        timestamp,
        oldValue: name,
      });
    }
  }

  for (const [name, oldField] of oldFieldsByName) {
    const newField = newFieldsByName.get(name);
    if (!newField) continue;

    if (oldField.fieldType !== newField.fieldType) {
      changes.push({
        changeType: 'modified',
        elementType: 'field',
        elementId: `${oldForm.formId}:${name}`,
        pageId,
        description: `Field type changed in ${oldForm.semanticName ?? oldForm.formId}: ${oldField.fieldType} → ${newField.fieldType}`,
        timestamp,
        oldValue: oldField.fieldType,
        newValue: newField.fieldType,
      });
    }

    if (oldField.required !== newField.required) {
      changes.push({
        changeType: 'modified',
        elementType: 'field',
        elementId: `${oldForm.formId}:${name}`,
        pageId,
        description: `Field required changed in ${oldForm.semanticName ?? oldForm.formId}: ${oldField.required} → ${newField.required}`,
        timestamp,
        oldValue: oldField.required,
        newValue: newField.required,
      });
    }
  }
}

function diffButtons(
  oldPage: PageDescriptor,
  newPage: PageDescriptor,
  changes: SiteChangeEntry[],
  brokenSelectors: RescanResult['brokenSelectors'],
  timestamp: string,
): void {
  const oldById = new Map(oldPage.buttons.map((b) => [b.buttonId, b]));
  const newById = new Map(newPage.buttons.map((b) => [b.buttonId, b]));

  for (const [id, btn] of newById) {
    if (!oldById.has(id)) {
      changes.push({
        changeType: 'added',
        elementType: 'button',
        elementId: id,
        pageId: newPage.pageId,
        description: `Button added: ${btn.text ?? btn.semanticAction ?? id}`,
        timestamp,
        newValue: btn.text,
      });
    }
  }

  for (const [id, btn] of oldById) {
    if (!newById.has(id)) {
      changes.push({
        changeType: 'removed',
        elementType: 'button',
        elementId: id,
        pageId: oldPage.pageId,
        description: `Button removed: ${btn.text ?? btn.semanticAction ?? id}`,
        timestamp,
        oldValue: btn.text,
      });
    }
  }

  for (const [id, oldBtn] of oldById) {
    const newBtn = newById.get(id);
    if (!newBtn) continue;

    if (oldBtn.text !== newBtn.text) {
      changes.push({
        changeType: 'modified',
        elementType: 'button',
        elementId: id,
        pageId: oldPage.pageId,
        description: `Button text changed: "${oldBtn.text}" → "${newBtn.text}"`,
        timestamp,
        oldValue: oldBtn.text,
        newValue: newBtn.text,
      });
    }

    checkBrokenSelector(
      oldBtn.selector,
      newBtn.selector,
      oldBtn.semanticAction ?? id,
      id,
      'button',
      oldPage.pageId,
      changes,
      brokenSelectors,
      timestamp,
    );
  }
}

function diffLinks(
  oldPage: PageDescriptor,
  newPage: PageDescriptor,
  changes: SiteChangeEntry[],
  brokenSelectors: RescanResult['brokenSelectors'],
  timestamp: string,
): void {
  const oldById = new Map(oldPage.links.map((l) => [l.linkId, l]));
  const newById = new Map(newPage.links.map((l) => [l.linkId, l]));

  for (const [id, link] of newById) {
    if (!oldById.has(id)) {
      changes.push({
        changeType: 'added',
        elementType: 'link',
        elementId: id,
        pageId: newPage.pageId,
        description: `Link added: ${link.text ?? link.href}`,
        timestamp,
        newValue: link.href,
      });
    }
  }

  for (const [id, link] of oldById) {
    if (!newById.has(id)) {
      changes.push({
        changeType: 'removed',
        elementType: 'link',
        elementId: id,
        pageId: oldPage.pageId,
        description: `Link removed: ${link.text ?? link.href}`,
        timestamp,
        oldValue: link.href,
      });
    }
  }

  for (const [id, oldLink] of oldById) {
    const newLink = newById.get(id);
    if (!newLink) continue;

    if (oldLink.href !== newLink.href) {
      changes.push({
        changeType: 'modified',
        elementType: 'link',
        elementId: id,
        pageId: oldPage.pageId,
        description: `Link href changed: "${oldLink.href}" → "${newLink.href}"`,
        timestamp,
        oldValue: oldLink.href,
        newValue: newLink.href,
      });
    }

    checkBrokenSelector(
      oldLink.selector,
      newLink.selector,
      oldLink.semanticAction ?? id,
      id,
      'link',
      oldPage.pageId,
      changes,
      brokenSelectors,
      timestamp,
    );
  }
}

function checkBrokenSelector(
  oldSelector: SelectorSet,
  newSelector: SelectorSet,
  toolName: string,
  elementId: string,
  elementType: 'button' | 'link',
  pageId: string,
  changes: SiteChangeEntry[],
  brokenSelectors: RescanResult['brokenSelectors'],
  timestamp: string,
): void {
  if (oldSelector.primary !== newSelector.primary) {
    if (newSelector.confidence < 0.5) {
      brokenSelectors.push({ toolName, selector: oldSelector });
      changes.push({
        changeType: 'selector-broken',
        elementType,
        elementId,
        pageId,
        description: `${elementType} selector changed with low confidence: ${oldSelector.primary}`,
        timestamp,
        oldValue: oldSelector.primary,
        newValue: newSelector.primary,
      });
    } else {
      changes.push({
        changeType: 'modified',
        elementType,
        elementId,
        pageId,
        description: `${elementType} selector updated: ${oldSelector.primary} → ${newSelector.primary}`,
        timestamp,
        oldValue: oldSelector.primary,
        newValue: newSelector.primary,
      });
    }
  }
}
