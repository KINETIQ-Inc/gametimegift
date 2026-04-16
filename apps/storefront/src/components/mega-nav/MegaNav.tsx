import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { Heading } from '@gtg/ui'
import {
  DEFAULT_MEGA_NAV_TAB,
  MEGA_NAV_TABS,
  getMegaNavTab,
  type MegaNavTab,
  type NavTabId,
} from '../../config/mega-nav'

type MobileSectionId = 'teams' | 'popular' | 'gifts'

interface MegaNavProps {
  onFilterSelect: (tabId: NavTabId) => void
}

const MOBILE_BREAKPOINT = 900

function splitTeams(teams: readonly { label: string; href: string }[]): Array<Array<{ label: string; href: string }>> {
  if (teams.length <= 8) return [teams.slice()]
  const mid = Math.ceil(teams.length / 2)
  return [teams.slice(0, mid), teams.slice(mid)]
}

function scrollToId(id: string): void {
  const target = document.getElementById(id)
  if (target && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

export function MegaNav({ onFilterSelect }: MegaNavProps) {
  const [activeTab, setActiveTab] = useState<NavTabId>(DEFAULT_MEGA_NAV_TAB)
  const [open, setOpen] = useState(false)
  const [locked, setLocked] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [desktopTeamsOpen, setDesktopTeamsOpen] = useState(false)
  const [mobileSections, setMobileSections] = useState<Record<MobileSectionId, boolean>>({
    teams: true,
    popular: true,
    gifts: true,
  })

  const shellRef = useRef<HTMLElement | null>(null)
  const closeTimer = useRef<number | null>(null)

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`)

    const sync = () => {
      const mobileNow = mq.matches
      setIsMobile(mobileNow)
      if (mobileNow) {
        setOpen(true)
        setLocked(true)
      } else {
        setOpen(false)
        setLocked(false)
      }
    }

    sync()
    mq.addEventListener('change', sync)
    return () => {
      mq.removeEventListener('change', sync)
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current)
      }
    }
  }, [])

  useEffect(() => {
    function onDocumentPointerDown(event: PointerEvent) {
      if (!open || isMobile || !locked || !shellRef.current) return
      const target = event.target as Node
      if (!shellRef.current.contains(target)) {
        setOpen(false)
        setLocked(false)
      }
    }

    function onDocumentKeyDown(event: globalThis.KeyboardEvent) {
      if (!open) return
      if (event.key === 'Escape') {
        setOpen(false)
        setLocked(false)
      }
    }

    document.addEventListener('pointerdown', onDocumentPointerDown)
    document.addEventListener('keydown', onDocumentKeyDown)

    return () => {
      document.removeEventListener('pointerdown', onDocumentPointerDown)
      document.removeEventListener('keydown', onDocumentKeyDown)
    }
  }, [open, isMobile, locked])

  const fallbackTab = MEGA_NAV_TABS[0]!
  const currentTab = getMegaNavTab(activeTab) ?? fallbackTab
  const teamColumns = useMemo(() => splitTeams(currentTab.teams), [currentTab])

  useEffect(() => {
    setDesktopTeamsOpen(false)
  }, [activeTab, isMobile])

  function clearCloseTimer() {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  function scheduleClose() {
    clearCloseTimer()
    closeTimer.current = window.setTimeout(() => {
      setOpen(false)
      setLocked(false)
    }, 130)
  }

  function activateTab(tab: MegaNavTab, lockPanel: boolean) {
    setActiveTab(tab.id)
    setOpen(true)
    if (lockPanel) setLocked(true)
  }

  function handleMouseEnterTab(tab: MegaNavTab) {
    if (isMobile) return
    clearCloseTimer()
    activateTab(tab, false)
  }

  function handleTabClick(tab: MegaNavTab) {
    onFilterSelect(tab.id)
    scrollToId('catalog')

    if (locked && activeTab === tab.id && !isMobile) {
      setLocked(false)
      setOpen(false)
      return
    }
    activateTab(tab, true)
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, tab: MegaNavTab) {
    const index = MEGA_NAV_TABS.findIndex((row) => row.id === tab.id)

    if (event.key === 'ArrowRight') {
      event.preventDefault()
      const next = MEGA_NAV_TABS[(index + 1) % MEGA_NAV_TABS.length]!
      activateTab(next, false)
      return
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      const prev = MEGA_NAV_TABS[(index - 1 + MEGA_NAV_TABS.length) % MEGA_NAV_TABS.length]!
      activateTab(prev, false)
      return
    }

    if (event.key === 'Escape') {
      setOpen(false)
      setLocked(false)
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onFilterSelect(tab.id)
      scrollToId('catalog')
      activateTab(tab, true)
    }
  }

  function handleTabFocus(tab: MegaNavTab, event: FocusEvent<HTMLButtonElement>) {
    if (event.currentTarget.matches(':focus-visible')) {
      activateTab(tab, false)
    }
  }

  function toggleMobileSection(section: MobileSectionId) {
    setMobileSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }))
  }

  return (
    <nav
      ref={shellRef}
      className="mega-nav-shell"
      aria-label="Shop by league and gift type"
      onMouseLeave={() => {
        if (isMobile || locked) return
        scheduleClose()
      }}
    >
      <div className="mega-nav-head">
        <p className="mega-nav-title">Browse by League</p>
        <p className="mega-nav-subtitle">Pick a league to filter products and jump into team collections.</p>
      </div>
      <div className="mega-tablist" role="tablist" aria-label="Leagues and collections">
        {MEGA_NAV_TABS.map((tab) => {
          const isActive = tab.id === activeTab
          return (
            <button
              key={tab.id}
              id={`mega-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls="mega-nav-panel"
              className={`mega-tab ${isActive ? 'active' : ''} ${tab.status === 'coming_soon' ? 'soon' : ''}`}
              onMouseEnter={() => handleMouseEnterTab(tab)}
              onFocus={(event) => handleTabFocus(tab, event)}
              onClick={() => handleTabClick(tab)}
              onKeyDown={(event) => onTabKeyDown(event, tab)}
            >
              <span>{tab.label}</span>
              {tab.status === 'coming_soon' ? <small>soon</small> : null}
            </button>
          )
        })}
      </div>

      {open ? (
        <section
          id="mega-nav-panel"
          className="mega-panel"
          role="region"
          aria-labelledby={`mega-tab-${currentTab.id}`}
          onMouseEnter={clearCloseTimer}
          onMouseLeave={() => {
            if (isMobile || locked) return
            scheduleClose()
          }}
        >
          {!isMobile ? (
            <>
              <div className="mega-teams">
                <button
                  type="button"
                  className="mega-section-toggle"
                  aria-expanded={desktopTeamsOpen}
                  aria-controls="mega-desktop-teams"
                  onClick={() => setDesktopTeamsOpen((current) => !current)}
                >
                  <span>Teams</span>
                  <span className={`mega-section-caret ${desktopTeamsOpen ? 'open' : ''}`} aria-hidden="true">
                    ▾
                  </span>
                </button>
                {desktopTeamsOpen ? (
                  <div id="mega-desktop-teams">
                    {currentTab.teams.length === 0 ? (
                      <p className="mega-empty">Team catalog opening soon for this league.</p>
                    ) : (
                      <div className="mega-team-columns">
                        {teamColumns.map((column, idx) => (
                          <ul key={`${currentTab.id}-col-${idx}`}>
                            {column.map((team) => (
                              <li key={team.label}>
                                <a href={team.href}>{team.label}</a>
                              </li>
                            ))}
                          </ul>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>

              <div className="mega-popular">
                <Heading as="h3" display={false}>Popular in {currentTab.label}</Heading>
                <ul>
                  {currentTab.popularPicks.map((pick) => (
                    <li key={pick.label}>
                      <a href={pick.href}>{pick.label}</a>
                      {pick.tag ? <em>{pick.tag}</em> : null}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mega-gifts">
                <Heading as="h3" display={false}>Shop by Gift Type</Heading>
                <ul>
                  {currentTab.giftTypes.map((gift) => (
                    <li key={gift.label}>
                      <a href={gift.href}>{gift.label}</a>
                    </li>
                  ))}
                </ul>

                <a href={currentTab.seasonal.href} className="mega-seasonal">
                  <strong>{currentTab.seasonal.title}</strong>
                  <span>{currentTab.seasonal.subtitle}</span>
                </a>
              </div>
            </>
          ) : (
            <div className="mega-mobile-accordion">
              <section className="mega-mobile-group">
                <button
                  type="button"
                  className="mega-mobile-toggle"
                  aria-expanded={mobileSections.teams}
                  aria-controls="mega-mobile-teams"
                  onClick={() => toggleMobileSection('teams')}
                >
                  Teams
                </button>
                {mobileSections.teams ? (
                  <div id="mega-mobile-teams" className="mega-mobile-content">
                    {currentTab.teams.length === 0 ? (
                      <p className="mega-empty">Team catalog opening soon for this league.</p>
                    ) : (
                      <ul>
                        {currentTab.teams.map((team) => (
                          <li key={team.label}>
                            <a href={team.href}>{team.label}</a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </section>

              <section className="mega-mobile-group">
                <button
                  type="button"
                  className="mega-mobile-toggle"
                  aria-expanded={mobileSections.popular}
                  aria-controls="mega-mobile-popular"
                  onClick={() => toggleMobileSection('popular')}
                >
                  Popular in {currentTab.label}
                </button>
                {mobileSections.popular ? (
                  <div id="mega-mobile-popular" className="mega-mobile-content">
                    <ul>
                      {currentTab.popularPicks.map((pick) => (
                        <li key={pick.label}>
                          <a href={pick.href}>{pick.label}</a>
                          {pick.tag ? <em>{pick.tag}</em> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>

              <section className="mega-mobile-group">
                <button
                  type="button"
                  className="mega-mobile-toggle"
                  aria-expanded={mobileSections.gifts}
                  aria-controls="mega-mobile-gifts"
                  onClick={() => toggleMobileSection('gifts')}
                >
                  Shop by Gift Type
                </button>
                {mobileSections.gifts ? (
                  <div id="mega-mobile-gifts" className="mega-mobile-content">
                    <ul>
                      {currentTab.giftTypes.map((gift) => (
                        <li key={gift.label}>
                          <a href={gift.href}>{gift.label}</a>
                        </li>
                      ))}
                    </ul>
                    <a href={currentTab.seasonal.href} className="mega-seasonal">
                      <strong>{currentTab.seasonal.title}</strong>
                      <span>{currentTab.seasonal.subtitle}</span>
                    </a>
                  </div>
                ) : null}
              </section>
            </div>
          )}
        </section>
      ) : null}
    </nav>
  )
}
