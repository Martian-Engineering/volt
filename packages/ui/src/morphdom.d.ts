declare module "morphdom" {
  export type MorphdomOptions = {
    childrenOnly?: boolean
    onBeforeElUpdated?: (fromEl: Element, toEl: Element) => boolean | void
  }

  export default function morphdom(
    fromNode: Element | DocumentFragment,
    toNode: Element | DocumentFragment,
    options?: MorphdomOptions,
  ): Element | DocumentFragment
}
