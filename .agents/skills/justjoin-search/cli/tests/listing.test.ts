import { describe, expect, test } from "bun:test"
import { extractListingUrls } from "../src/helpers.js"

const page = (ld: unknown) => `<html><script type="application/ld+json">${JSON.stringify(ld)}</script></html>`

describe("extractListingUrls", () => {
  test("returns the offer URLs of a CollectionPage", () => {
    const html = page({
      "@type": "CollectionPage",
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: 1,
        itemListElement: [{ url: "https://justjoin.it/job-offer/acme-network-engineer-krakow-devops" }],
      },
    })
    expect(extractListingUrls(html)).toEqual(["https://justjoin.it/job-offer/acme-network-engineer-krakow-devops"])
  })

  test("a search with no matches is an empty list, not a failure", () => {
    const html = page({ "@type": "CollectionPage", mainEntity: { "@type": "ItemList", numberOfItems: 0, itemListElement: [] } })
    expect(extractListingUrls(html)).toEqual([])
  })

  test("a page without a CollectionPage list is null", () => {
    expect(extractListingUrls(page({ "@type": "BreadcrumbList" }))).toBeNull()
  })
})
