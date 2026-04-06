export interface PdfTarget {
  sourceItem: Zotero.Item;
  attachment: Zotero.Item;
  parentItem: Zotero.Item | null;
  filePath: string;
  fileName: string;
  displayTitle: string;
  libraryID: number;
  noteParentID?: number;
  dataID: string;
}

export async function getSelectedPdfTargets(): Promise<PdfTarget[]> {
  const mainWindow = Zotero.getMainWindow();
  const selectedItems = (mainWindow.ZoteroPane.getSelectedItems() || []) as Zotero.Item[];
  const targets: PdfTarget[] = [];
  const seenAttachmentIDs = new Set<number>();

  for (const item of selectedItems) {
    const attachment = await resolvePdfAttachment(item);
    if (!attachment || seenAttachmentIDs.has(attachment.id)) {
      continue;
    }
    seenAttachmentIDs.add(attachment.id);

    const filePath = attachment.getFilePath();
    if (!filePath) {
      continue;
    }

    const parentItem =
      attachment.parentItemID && attachment.parentItemID > 0
        ? ((await Zotero.Items.getAsync(attachment.parentItemID)) as Zotero.Item)
        : item.isRegularItem()
          ? item
          : null;

    targets.push({
      sourceItem: item,
      attachment,
      parentItem,
      filePath,
      fileName:
        attachment.attachmentFilename ||
        (attachment as any).getFilename?.() ||
        `${attachment.id}.pdf`,
      displayTitle:
        parentItem?.getDisplayTitle() ||
        attachment.getDisplayTitle() ||
        attachment.attachmentFilename ||
        `PDF ${attachment.id}`,
      libraryID: attachment.libraryID,
      noteParentID: parentItem?.id,
      dataID: String(attachment.id),
    });
  }

  return targets;
}

async function resolvePdfAttachment(item: Zotero.Item): Promise<Zotero.Item | null> {
  if (isPdfAttachment(item)) {
    return item;
  }

  if (!item.isRegularItem()) {
    return null;
  }

  const attachmentIDs = item.getAttachments?.() || [];
  for (const attachmentID of attachmentIDs) {
    const attachment = (await Zotero.Items.getAsync(attachmentID)) as Zotero.Item;
    if (isPdfAttachment(attachment)) {
      return attachment;
    }
  }

  return null;
}

function isPdfAttachment(item: Zotero.Item) {
  const candidate = item as any;
  return Boolean(
    candidate?.isPDFAttachment?.() ||
      (candidate?.isAttachment?.() &&
        candidate?.attachmentContentType === "application/pdf"),
  );
}
