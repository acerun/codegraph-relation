import { RelationItem } from '../../shared/common/types';

export function applyPrefetchedChildren(item: RelationItem, children: RelationItem[]) {
    item.children = children;
    item.hasChildren = children.length > 0;
    item.hasChildrenKnown = true;
}

export function shouldPublishResolvedChildren(hasPublishedUpdate: boolean, children: RelationItem[]) {
    return !hasPublishedUpdate && children.length === 0;
}
