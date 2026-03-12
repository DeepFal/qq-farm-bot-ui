<script setup lang="ts">
import type { AccountSettingsPayload, AutomationConfig } from '@/stores/setting'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch, watchEffect } from 'vue'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'
import { getPlatformClass, getPlatformLabel, useAccountStore } from '@/stores/account'
import { useFarmStore } from '@/stores/farm'
import { useSettingStore } from '@/stores/setting'
import { useToastStore } from '@/stores/toast'

const settingStore = useSettingStore()
const accountStore = useAccountStore()
const farmStore = useFarmStore()
const toast = useToastStore()

const { settings, loading } = storeToRefs(settingStore)
const { currentAccountId, accounts } = storeToRefs(accountStore)
const { seeds } = storeToRefs(farmStore)

const saving = ref(false)
const passwordSaving = ref(false)
const offlineSaving = ref(false)
const offlineTesting = ref(false)
const qrSaving = ref(false)
const runtimeClientSaving = ref(false)
const settingsSyncModalVisible = ref(false)
const settingsSyncMode = ref<'all' | 'selected'>('all')
const settingsSyncTargetIds = ref<string[]>([])
const settingsSyncSaving = ref(false)

// 密码认证相关状态
const passwordAuthDisabled = ref(false)
const passwordAuthLoading = ref(false)

const token = computed(() => {
  return localStorage.getItem('admin_token') || '未登录'
})

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).then(() => {
    toast.success('复制成功')
  }).catch(() => {
    toast.error('复制失败，请手动复制')
  })
}

const modalVisible = ref(false)
const modalConfig = ref({
  title: '',
  message: '',
  type: 'primary' as 'primary' | 'danger',
  isAlert: true,
})

function showAlert(message: string, type: 'primary' | 'danger' = 'primary') {
  modalConfig.value = {
    title: type === 'danger' ? '错误' : '提示',
    message,
    type,
    isAlert: true,
  }
  modalVisible.value = true
}

const currentAccountName = computed(() => {
  const acc = accounts.value.find((a: any) => a.id === currentAccountId.value)
  return acc ? (acc.name || acc.nick || acc.id) : null
})
const syncableAccounts = computed(() =>
  accounts.value.filter((account: any) => String(account?.id || '') !== String(currentAccountId.value || '')),
)
const selectedSettingsSyncAccounts = computed(() => {
  const selectedIdSet = new Set(settingsSyncTargetIds.value.map(id => String(id || '')))
  return syncableAccounts.value.filter((account: any) => selectedIdSet.has(String(account?.id || '')))
})
const selectedSettingsSyncCount = computed(() => selectedSettingsSyncAccounts.value.length)
const settingsSyncSummaryText = computed(() => {
  if (settingsSyncMode.value === 'all')
    return `将同步到除当前账号外的全部 ${syncableAccounts.value.length} 个账号`

  if (selectedSettingsSyncCount.value === 0)
    return '请选择至少一个目标账号'

  return `已选择 ${selectedSettingsSyncCount.value} 个目标账号`
})
const BAG_PRIORITY_STRATEGY = 'bag_priority'
const DEFAULT_BAG_SEED_FALLBACK_STRATEGY = 'level'
const BAG_FALLBACK_STRATEGY_VALUES = new Set(['preferred', 'level', 'max_exp', 'max_fert_exp', 'max_profit', 'max_fert_profit'])
const allFertilizerLandTypes = ['gold', 'black', 'red', 'normal']

const fertilizerBuyTypeOptions = [
  { label: '仅有机化肥', value: 'organic' },
  { label: '仅普通化肥', value: 'normal' },
  { label: '两者都买', value: 'both' },
]

const fertilizerBuyModeOptions = [
  { label: '容器不足时购买', value: 'threshold' },
  { label: '无限购买', value: 'unlimited' },
]

const fertilizerLandTypeOptions = [
  { label: '金土地', value: 'gold' },
  { label: '黑土地', value: 'black' },
  { label: '红土地', value: 'red' },
  { label: '普通土地', value: 'normal' },
]

function normalizeFertilizerLandTypes(input: unknown) {
  const source = Array.isArray(input) ? input : allFertilizerLandTypes
  const normalized: string[] = []
  for (const item of source) {
    const value = String(item || '').trim().toLowerCase()
    if (!allFertilizerLandTypes.includes(value))
      continue
    if (normalized.includes(value))
      continue
    normalized.push(value)
  }
  return normalized
}

function normalizeStealPlantBlacklist(input: unknown) {
  const source = Array.isArray(input) ? input : []
  const normalized: number[] = []
  for (const item of source) {
    const value = Number.parseInt(String(item), 10)
    if (!Number.isFinite(value) || value <= 0)
      continue
    if (normalized.includes(value))
      continue
    normalized.push(value)
  }
  return normalized
}

function normalizeBagSeedPriority(input: unknown) {
  const source = Array.isArray(input) ? input : []
  const normalized: number[] = []
  for (const item of source) {
    const value = Number.parseInt(String(item), 10)
    if (!Number.isFinite(value) || value <= 0)
      continue
    if (normalized.includes(value))
      continue
    normalized.push(value)
  }
  return normalized
}

const localSettings = ref({
  plantingStrategy: 'preferred',
  preferredSeedId: 0,
  bagSeedPriority: [] as number[],
  bagSeedFallbackStrategy: DEFAULT_BAG_SEED_FALLBACK_STRATEGY,
  intervals: { farmMin: 2, farmMax: 2, friendMin: 10, friendMax: 10 },
  friendQuietHours: { enabled: false, start: '23:00', end: '07:00' },
  automation: {
    farm: false,
    farm_manage: false,
    farm_water: false,
    farm_weed: false,
    farm_bug: false,
    task: false,
    sell: false,
    friend: false,
    farm_push: false,
    land_upgrade: false,
    friend_steal: false,
    friend_steal_blacklist: [] as number[],
    friend_help: false,
    friend_bad: false,
    friend_help_exp_limit: false,
    email: false,
    fertilizer_gift: false,
    fertilizer_buy: false,
    fertilizer_buy_type: 'organic' as AutomationConfig['fertilizer_buy_type'],
    fertilizer_buy_max: 10,
    fertilizer_buy_mode: 'threshold' as AutomationConfig['fertilizer_buy_mode'],
    fertilizer_buy_threshold: 100,
    free_gifts: false,
    share_reward: false,
    vip_gift: false,
    month_card: false,
    open_server_gift: false,
    fertilizer: 'none',
    fertilizer_multi_season: false,
    fertilizer_land_types: [...allFertilizerLandTypes],
  },
})

interface BagSeedItem {
  seedId: number
  name: string
  count: number
  requiredLevel: number
  image: string
  plantSize: number
}

const bagSeeds = ref<BagSeedItem[]>([])
const bagSeedsLoading = ref(false)
const bagSeedsError = ref('')
const bagSeedsLoadedAccountId = ref('')
const loadingAccountSettings = ref(false)
let bagSeedsRequestSerial = 0

const friendDisabled = computed(() => !localSettings.value.automation.friend)
const farmDisabled = computed(() => !localSettings.value.automation.farm_manage)

interface StealCropOption {
  plantId: number
  seedId: number | null
  name: string
  level: number | null
  image: string
}

interface AnalyticsCropMeta {
  plantId: number
  seedId: number | null
  name: string
  level: number | null
  image: string
}

const analyticsCropMetas = ref<AnalyticsCropMeta[]>([])
const stealBlacklistSearch = ref('')
const stealBlacklistCollapsed = ref(true)
const onlyShowUnselectedStealCrops = ref(false)

watch(() => localSettings.value.automation.fertilizer_buy_mode, (mode) => {
  if (mode === 'unlimited' && localSettings.value.automation.fertilizer_buy_type === 'both')
    localSettings.value.automation.fertilizer_buy_type = 'organic'
})

watch(() => localSettings.value.automation.fertilizer_buy_type, (type) => {
  if (type === 'both' && localSettings.value.automation.fertilizer_buy_mode === 'unlimited')
    localSettings.value.automation.fertilizer_buy_mode = 'threshold'
})

function parsePositiveInt(input: unknown): number | null {
  const value = Number.parseInt(String(input ?? ''), 10)
  if (!Number.isFinite(value) || value <= 0)
    return null
  return value
}

function sortBagSeedsForDisplay(source: BagSeedItem[], priority: number[]) {
  const indexMap = new Map<number, number>()
  normalizeBagSeedPriority(priority).forEach((seedId, index) => {
    indexMap.set(seedId, index)
  })

  return [...source].sort((a, b) => {
    const aIndex = indexMap.has(a.seedId) ? indexMap.get(a.seedId)! : Number.MAX_SAFE_INTEGER
    const bIndex = indexMap.has(b.seedId) ? indexMap.get(b.seedId)! : Number.MAX_SAFE_INTEGER
    if (aIndex !== bIndex)
      return aIndex - bIndex
    if (a.requiredLevel !== b.requiredLevel)
      return b.requiredLevel - a.requiredLevel
    return a.seedId - b.seedId
  })
}

function getDefaultBagSeedPriority(source: BagSeedItem[]) {
  return sortBagSeedsForDisplay(source, []).map(seed => seed.seedId)
}

function mergeBagSeedPriority(source: unknown, bagSeedList: BagSeedItem[]) {
  const merged = normalizeBagSeedPriority(source)
  for (const seedId of getDefaultBagSeedPriority(bagSeedList)) {
    if (!merged.includes(seedId))
      merged.push(seedId)
  }
  return merged
}

function resolveStealCropLevel(seed: any): number | null {
  const candidates = [
    seed?.requiredLevel,
    seed?.landLevelNeed,
    seed?.land_level_need,
    seed?.unlockLevel,
    seed?.levelNeed,
  ]

  for (const candidate of candidates) {
    const value = Number(candidate)
    if (Number.isFinite(value) && value > 0)
      return value
  }

  return null
}

function resolveStealCropImage(seed: any): string {
  const candidates = [
    seed?.image,
    seed?.seedImage,
    seed?.itemImage,
    seed?.icon,
    seed?.iconUrl,
  ]

  for (const candidate of candidates) {
    const value = String(candidate || '').trim()
    if (value)
      return value
  }

  return ''
}

function normalizeAnalyticsCropLevel(input: unknown): number | null {
  const value = Number(input)
  if (!Number.isFinite(value) || value <= 0)
    return null
  return value
}

async function loadStealBlacklistAnalytics() {
  try {
    const res = await api.get('/api/analytics', {
      params: { sort: 'level' },
    })
    const data = res?.data?.ok ? (res.data.data || []) : []
    if (!Array.isArray(data)) {
      analyticsCropMetas.value = []
      return
    }

    const parsed: AnalyticsCropMeta[] = []
    for (const item of data) {
      const plantId = parsePositiveInt(item?.id ?? item?.plantId)
      if (plantId === null)
        continue
      parsed.push({
        plantId,
        seedId: parsePositiveInt(item?.seedId),
        name: String(item?.name || ''),
        level: normalizeAnalyticsCropLevel(item?.level),
        image: String(item?.image || '').trim(),
      })
    }
    analyticsCropMetas.value = parsed
  }
  catch {
    analyticsCropMetas.value = []
  }
}

const analyticsCropMetaByPlantId = computed(() => {
  const byPlantId = new Map<number, AnalyticsCropMeta>()
  for (const item of analyticsCropMetas.value) {
    const current = byPlantId.get(item.plantId)
    if (!current) {
      byPlantId.set(item.plantId, { ...item })
      continue
    }
    if (current.seedId === null && item.seedId !== null)
      current.seedId = item.seedId
    if (current.level === null && item.level !== null)
      current.level = item.level
    if (!current.image && item.image)
      current.image = item.image
    if (!current.name && item.name)
      current.name = item.name
  }
  return byPlantId
})

const stealCropOptions = computed<StealCropOption[]>(() => {
  const source = Array.isArray(seeds.value) ? seeds.value : []
  const byPlantId = new Map<number, StealCropOption>()
  const isPlaceholderName = (name: string, plantId: number) => {
    const normalized = String(name || '').trim()
    return !normalized || normalized === `作物#${plantId}` || normalized === `浣滅墿#${plantId}`
  }

  // 先用分析数据作为全量基准，避免登录后只显示商店返回的子集
  for (const meta of analyticsCropMetas.value) {
    const plantId = parsePositiveInt(meta?.plantId)
    if (plantId === null)
      continue

    byPlantId.set(plantId, {
      plantId,
      seedId: parsePositiveInt(meta?.seedId),
      name: String(meta?.name || `作物#${plantId}`),
      level: normalizeAnalyticsCropLevel(meta?.level),
      image: String(meta?.image || '').trim(),
    })
  }

  for (const seed of source) {
    const plantId = parsePositiveInt(seed?.plantId)
    if (plantId === null)
      continue

    const analyticsMeta = analyticsCropMetaByPlantId.value.get(plantId)
    const seedIdFromSeed = parsePositiveInt(seed?.seedId ?? seed?.seed_id ?? seed?.itemId)
    const next: StealCropOption = {
      plantId,
      seedId: seedIdFromSeed ?? analyticsMeta?.seedId ?? null,
      name: String(seed?.name || analyticsMeta?.name || `作物#${plantId}`),
      level: analyticsMeta?.level ?? resolveStealCropLevel(seed),
      image: resolveStealCropImage(seed) || String(analyticsMeta?.image || '').trim(),
    }

    const current = byPlantId.get(plantId)
    if (!current) {
      byPlantId.set(plantId, next)
      continue
    }

    if (current.seedId === null && next.seedId !== null)
      current.seedId = next.seedId
    if (!current.image && next.image)
      current.image = next.image
    if (current.level === null && next.level !== null)
      current.level = next.level
    if (isPlaceholderName(current.name, current.plantId) && next.name)
      current.name = next.name
  }

  return Array.from(byPlantId.values()).sort((a, b) => {
    const aLevel = a.level === null ? Number.POSITIVE_INFINITY : a.level
    const bLevel = b.level === null ? Number.POSITIVE_INFINITY : b.level
    if (aLevel !== bLevel)
      return aLevel - bLevel

    const aSeedId = a.seedId === null ? Number.POSITIVE_INFINITY : a.seedId
    const bSeedId = b.seedId === null ? Number.POSITIVE_INFINITY : b.seedId
    if (aSeedId !== bSeedId)
      return aSeedId - bSeedId

    return a.plantId - b.plantId
  })
})
// unlimited + both 互斥：切到 unlimited 时自动重置为 organic
watch(() => localSettings.value.automation.fertilizer_buy_mode, (mode) => {
  if (mode === 'unlimited' && localSettings.value.automation.fertilizer_buy_type === 'both')
    localSettings.value.automation.fertilizer_buy_type = 'organic'
})
// 切到 both 时若模式为 unlimited，自动重置为 threshold
watch(() => localSettings.value.automation.fertilizer_buy_type, (type) => {
  if (type === 'both' && localSettings.value.automation.fertilizer_buy_mode === 'unlimited')
    localSettings.value.automation.fertilizer_buy_mode = 'threshold'
})

const stealBlacklistCount = computed(() => normalizeStealPlantBlacklist(localSettings.value.automation.friend_steal_blacklist).length)
const stealBlacklistSet = computed(() => new Set(normalizeStealPlantBlacklist(localSettings.value.automation.friend_steal_blacklist)))

function isCropBlacklisted(plantId: number) {
  return stealBlacklistSet.value.has(plantId)
}

function toggleStealBlacklistCrop(plantId: number) {
  const current = normalizeStealPlantBlacklist(localSettings.value.automation.friend_steal_blacklist)
  if (current.includes(plantId)) {
    localSettings.value.automation.friend_steal_blacklist = current.filter(id => id !== plantId)
    return
  }
  localSettings.value.automation.friend_steal_blacklist = [...current, plantId]
}

const filteredStealCropOptions = computed(() => {
  const keyword = stealBlacklistSearch.value.trim().toLowerCase()

  return stealCropOptions.value.filter((crop) => {
    const byName = crop.name.toLowerCase().includes(keyword)
    const bySeedId = crop.seedId !== null && String(crop.seedId).includes(keyword)
    const keywordMatched = !keyword || byName || bySeedId
    const unselectedMatched = !onlyShowUnselectedStealCrops.value || !isCropBlacklisted(crop.plantId)
    return keywordMatched && unselectedMatched
  })
})

function filterUnselectedStealCrops() {
  onlyShowUnselectedStealCrops.value = !onlyShowUnselectedStealCrops.value
  if (onlyShowUnselectedStealCrops.value)
    stealBlacklistSearch.value = ''
}

function clearStealFilter() {
  onlyShowUnselectedStealCrops.value = false
  stealBlacklistSearch.value = ''
}

const isBagPriorityStrategy = computed(() => localSettings.value.plantingStrategy === BAG_PRIORITY_STRATEGY)
const bagPrioritySeedSource = computed(() => bagSeeds.value.filter(seed => seed.plantSize === 1 && seed.count > 0))
const bagPrioritySeedOptions = computed(() => sortBagSeedsForDisplay(
  bagPrioritySeedSource.value,
  localSettings.value.bagSeedPriority,
))
const bagSeedOrderIds = computed(() => bagPrioritySeedOptions.value.map(seed => seed.seedId))
const skippedBagSeedCount = computed(() => bagSeeds.value.filter(seed => seed.count > 0 && seed.plantSize !== 1).length)
const draggingBagSeedId = ref<number | null>(null)
const dropTargetBagSeedId = ref<number | null>(null)

function applyBagSeedOrder(nextOrder: number[]) {
  const visibleSeedIdSet = new Set(nextOrder)
  const hiddenSeedIds = normalizeBagSeedPriority(localSettings.value.bagSeedPriority)
    .filter(id => !visibleSeedIdSet.has(id))
  localSettings.value.bagSeedPriority = [...nextOrder, ...hiddenSeedIds]
}

function resetBagSeedState() {
  bagSeedsRequestSerial += 1
  bagSeeds.value = []
  bagSeedsError.value = ''
  bagSeedsLoading.value = false
  bagSeedsLoadedAccountId.value = ''
}

async function loadBagSeeds(force = false, accountId = currentAccountId.value) {
  if (!accountId || !isBagPriorityStrategy.value) {
    resetBagSeedState()
    return
  }
  if (!force && bagSeedsLoadedAccountId.value === accountId && bagSeeds.value.length > 0)
    return

  const requestId = ++bagSeedsRequestSerial
  bagSeedsLoading.value = true
  bagSeedsError.value = ''

  try {
    const { data } = await api.get('/api/bag/seeds', {
      headers: { 'x-account-id': accountId },
    })

    if (requestId !== bagSeedsRequestSerial || accountId !== currentAccountId.value || !isBagPriorityStrategy.value)
      return

    if (!data?.ok) {
      bagSeeds.value = []
      bagSeedsLoadedAccountId.value = ''
      bagSeedsError.value = data?.error || '背包种子加载失败'
      return
    }

    const parsedSource: unknown[] = Array.isArray(data.data) ? data.data : []
    const parsed = parsedSource
      .map((item: unknown): BagSeedItem | null => {
        const bagItem = (item && typeof item === 'object') ? item as Record<string, unknown> : {}
        const seedId = parsePositiveInt(bagItem.seedId)
        if (seedId === null)
          return null
        return {
          seedId,
          name: String(bagItem.name || `种子#${seedId}`),
          count: Math.max(0, Number(bagItem.count || 0)),
          requiredLevel: Math.max(0, Number(bagItem.requiredLevel || 0)),
          image: String(bagItem.image || '').trim(),
          plantSize: Math.max(1, Number(bagItem.plantSize || 1)),
        }
      })
      .filter((item: BagSeedItem | null): item is BagSeedItem => item !== null)

    bagSeeds.value = parsed
    bagSeedsLoadedAccountId.value = accountId
    localSettings.value.bagSeedPriority = mergeBagSeedPriority(
      localSettings.value.bagSeedPriority,
      bagPrioritySeedSource.value,
    )
  }
  catch (error: any) {
    if (requestId !== bagSeedsRequestSerial || accountId !== currentAccountId.value || !isBagPriorityStrategy.value)
      return

    bagSeeds.value = []
    bagSeedsLoadedAccountId.value = ''
    bagSeedsError.value = error?.response?.data?.error || error?.message || '背包种子加载失败'
  }
  finally {
    if (requestId === bagSeedsRequestSerial)
      bagSeedsLoading.value = false
  }
}

function moveBagSeed(seedId: number, direction: -1 | 1) {
  const nextOrder = [...bagSeedOrderIds.value]
  const index = nextOrder.findIndex(id => id === seedId)
  const targetIndex = index + direction
  if (index < 0 || targetIndex < 0 || targetIndex >= nextOrder.length) {
    return
  }

  const currentSeedId = nextOrder[index]!
  const targetSeedId = nextOrder[targetIndex]!
  nextOrder[index] = targetSeedId
  nextOrder[targetIndex] = currentSeedId
  applyBagSeedOrder(nextOrder)
}

function resetBagSeedPriority() {
  const nextOrder = getDefaultBagSeedPriority(bagPrioritySeedSource.value)
  applyBagSeedOrder(nextOrder)
}

function startBagSeedDrag(seedId: number, event: DragEvent) {
  draggingBagSeedId.value = seedId
  dropTargetBagSeedId.value = seedId
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(seedId))
  }
}

function dragOverBagSeed(seedId: number, event: DragEvent) {
  if (draggingBagSeedId.value === null)
    return
  event.preventDefault()
  dropTargetBagSeedId.value = seedId
  if (event.dataTransfer)
    event.dataTransfer.dropEffect = 'move'
}

function dropBagSeed(seedId: number, event: DragEvent) {
  event.preventDefault()
  const sourceSeedId = draggingBagSeedId.value
    ?? Number.parseInt(event.dataTransfer?.getData('text/plain') || '', 10)
  if (!Number.isFinite(sourceSeedId) || sourceSeedId <= 0 || sourceSeedId === seedId) {
    endBagSeedDrag()
    return
  }

  const nextOrder = [...bagSeedOrderIds.value]
  const sourceIndex = nextOrder.findIndex(id => id === sourceSeedId)
  const targetIndex = nextOrder.findIndex(id => id === seedId)
  if (sourceIndex < 0 || targetIndex < 0) {
    endBagSeedDrag()
    return
  }

  const movedSeedId = nextOrder[sourceIndex]!
  nextOrder.splice(sourceIndex, 1)
  const nextTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
  nextOrder.splice(nextTargetIndex, 0, movedSeedId)
  applyBagSeedOrder(nextOrder)
  endBagSeedDrag()
}

function endBagSeedDrag() {
  draggingBagSeedId.value = null
  dropTargetBagSeedId.value = null
}

const localOffline = ref({
  channel: 'webhook',
  reloginUrlMode: 'none',
  endpoint: '',
  token: '',
  title: '',
  msg: '',
  offlineDeleteSec: 1,
  offlineDeleteEnabled: false,
  custom_headers: '',
  custom_body: '',
})

const localQrLogin = ref({
  apiDomain: 'q.qq.com',
})

const localRuntimeClient = ref({
  serverUrl: 'wss://gate-obt.nqf.qq.com/prod/ws',
  clientVersion: '1.6.2.18_20260227',
  os: 'iOS',
  device_info: {
    sys_software: 'iOS 26.2.1',
    network: 'wifi',
    memory: '7672',
    device_id: 'iPhone X<iPhone18,3>',
  },
})

const passwordForm = ref({
  old: '',
  new: '',
  confirm: '',
})

function syncLocalSettings() {
  if (settings.value) {
    localSettings.value = JSON.parse(JSON.stringify({
      plantingStrategy: settings.value.plantingStrategy,
      preferredSeedId: settings.value.preferredSeedId,
      bagSeedPriority: settings.value.bagSeedPriority,
      bagSeedFallbackStrategy: settings.value.bagSeedFallbackStrategy,
      intervals: settings.value.intervals,
      friendQuietHours: settings.value.friendQuietHours,
      automation: settings.value.automation,
    }))

    // Default automation values if missing
    if (!localSettings.value.automation) {
      localSettings.value.automation = {
        farm: false,
        farm_manage: false,
        farm_water: false,
        farm_weed: false,
        farm_bug: false,
        task: false,
        sell: false,
        friend: false,
        farm_push: false,
        land_upgrade: false,
        friend_steal: false,
        friend_steal_blacklist: [] as number[],
        friend_help: false,
        friend_bad: false,
        friend_help_exp_limit: false,
        email: false,
        fertilizer_gift: false,
        fertilizer_buy: false,
        fertilizer_buy_type: 'organic' as AutomationConfig['fertilizer_buy_type'],
        fertilizer_buy_max: 10,
        fertilizer_buy_mode: 'threshold' as AutomationConfig['fertilizer_buy_mode'],
        fertilizer_buy_threshold: 100,
        free_gifts: false,
        share_reward: false,
        vip_gift: false,
        month_card: false,
        open_server_gift: false,
        fertilizer: 'none',
        fertilizer_multi_season: false,
        fertilizer_land_types: [...allFertilizerLandTypes],
      }
    }
    else {
      // Merge with defaults to ensure all keys exist
      const defaults = {
        farm: false,
        farm_manage: false,
        farm_water: false,
        farm_weed: false,
        farm_bug: false,
        task: false,
        sell: false,
        friend: false,
        farm_push: false,
        land_upgrade: false,
        friend_steal: false,
        friend_steal_blacklist: [] as number[],
        friend_help: false,
        friend_bad: false,
        friend_help_exp_limit: false,
        email: false,
        fertilizer_gift: false,
        fertilizer_buy: false,
        fertilizer_buy_type: 'organic' as AutomationConfig['fertilizer_buy_type'],
        fertilizer_buy_max: 10,
        fertilizer_buy_mode: 'threshold' as AutomationConfig['fertilizer_buy_mode'],
        fertilizer_buy_threshold: 100,
        free_gifts: false,
        share_reward: false,
        vip_gift: false,
        month_card: false,
        open_server_gift: false,
        fertilizer: 'none',
        fertilizer_multi_season: false,
        fertilizer_land_types: [...allFertilizerLandTypes],
      }
      localSettings.value.automation = {
        ...defaults,
        ...localSettings.value.automation,
      }
    }

    localSettings.value.automation.fertilizer_land_types = normalizeFertilizerLandTypes(localSettings.value.automation.fertilizer_land_types)
    localSettings.value.automation.friend_steal_blacklist = normalizeStealPlantBlacklist(localSettings.value.automation.friend_steal_blacklist)
    localSettings.value.bagSeedPriority = normalizeBagSeedPriority(localSettings.value.bagSeedPriority)
    if (
      localSettings.value.bagSeedFallbackStrategy === BAG_PRIORITY_STRATEGY
      || !BAG_FALLBACK_STRATEGY_VALUES.has(localSettings.value.bagSeedFallbackStrategy)
    ) {
      localSettings.value.bagSeedFallbackStrategy = DEFAULT_BAG_SEED_FALLBACK_STRATEGY
    }

    // Sync offline settings (global)
    if (settings.value.offlineReminder) {
      localOffline.value = {
        ...localOffline.value,
        ...JSON.parse(JSON.stringify(settings.value.offlineReminder)),
      }
    }
    localOffline.value.offlineDeleteSec = Math.max(1, Number.parseInt(String(localOffline.value.offlineDeleteSec), 10) || 1)
    localOffline.value.offlineDeleteEnabled = !!localOffline.value.offlineDeleteEnabled
    if (settings.value.qrLogin) {
      localQrLogin.value = JSON.parse(JSON.stringify(settings.value.qrLogin))
    }
    if (settings.value.runtimeClient) {
      localRuntimeClient.value = JSON.parse(JSON.stringify(settings.value.runtimeClient))
    }
  }
}

async function loadData() {
  const accountId = currentAccountId.value
  if (!accountId) {
    resetBagSeedState()
    return
  }

  loadingAccountSettings.value = true
  try {
    resetBagSeedState()
    await settingStore.fetchSettings(accountId)
    if (accountId !== currentAccountId.value)
      return

    syncLocalSettings()
    if (accountId !== currentAccountId.value)
      return

    // Always fetch seeds to ensure correct locked status for current account
    await Promise.all([
      farmStore.fetchSeeds(accountId),
      loadStealBlacklistAnalytics(),
    ])
    if (accountId !== currentAccountId.value)
      return

    if (localSettings.value.plantingStrategy === BAG_PRIORITY_STRATEGY)
      await loadBagSeeds(true, accountId)
  }
  finally {
    loadingAccountSettings.value = false
  }
}

onMounted(() => {
  loadData()
  fetchPasswordAuthStatus()
})

watch(currentAccountId, () => {
  settingsSyncModalVisible.value = false
  settingsSyncMode.value = 'all'
  settingsSyncTargetIds.value = []
  loadData()
})

const fertilizerOptions = [
  { label: '普通 + 有机', value: 'both' },
  { label: '仅普通化肥', value: 'normal' },
  { label: '仅有机化肥', value: 'organic' },
  { label: '不施肥', value: 'none' },
]

const plantingStrategyOptions = [
  { label: '优先种植种子', value: 'preferred' },
  { label: '最高等级作物', value: 'level' },
  { label: '最大经验/时', value: 'max_exp' },
  { label: '最大普通肥经验/时', value: 'max_fert_exp' },
  { label: '最大净利润/时', value: 'max_profit' },
  { label: '最大普通肥净利润/时', value: 'max_fert_profit' },
  { label: '背包种子优先', value: BAG_PRIORITY_STRATEGY },
]

const bagSeedFallbackStrategyOptions = computed(() =>
  plantingStrategyOptions.filter(option => option.value !== BAG_PRIORITY_STRATEGY),
)

watch(() => localSettings.value.plantingStrategy, (strategy) => {
  if (loadingAccountSettings.value)
    return
  if (strategy === BAG_PRIORITY_STRATEGY) {
    loadBagSeeds()
    return
  }
  resetBagSeedState()
})

watch(() => localSettings.value.bagSeedFallbackStrategy, (strategy) => {
  if (
    strategy === BAG_PRIORITY_STRATEGY
    || !bagSeedFallbackStrategyOptions.value.some(option => option.value === strategy)
  ) {
    localSettings.value.bagSeedFallbackStrategy = DEFAULT_BAG_SEED_FALLBACK_STRATEGY
  }
})

const channelOptions = [
  { label: 'Webhook(自定义接口)', value: 'webhook' },
  { label: '自定义 JSON (Webhook)', value: 'custom_request' },
  { label: 'Qmsg 酱', value: 'qmsg' },
  { label: 'Server 酱', value: 'serverchan' },
  { label: 'Push Plus', value: 'pushplus' },
  { label: 'Push Plus Hxtrip', value: 'pushplushxtrip' },
  { label: '钉钉', value: 'dingtalk' },
  { label: '企业微信', value: 'wecom' },
  { label: 'Bark', value: 'bark' },
  { label: 'Go-cqhttp', value: 'gocqhttp' },
  { label: 'OneBot', value: 'onebot' },
  { label: 'Atri', value: 'atri' },
  { label: 'PushDeer', value: 'pushdeer' },
  { label: 'iGot', value: 'igot' },
  { label: 'Telegram', value: 'telegram' },
  { label: '飞书', value: 'feishu' },
  { label: 'IFTTT', value: 'ifttt' },
  { label: '企业微信群机器人', value: 'wecombot' },
  { label: 'Discord', value: 'discord' },
  { label: 'WxPusher', value: 'wxpusher' },
]

const CHANNEL_DOCS: Record<string, string> = {
  webhook: '',
  custom_request: '',
  qmsg: 'https://qmsg.zendee.cn/',
  serverchan: 'https://sct.ftqq.com/',
  pushplus: 'https://www.pushplus.plus/',
  pushplushxtrip: 'https://pushplus.hxtrip.com/',
  dingtalk: 'https://open.dingtalk.com/document/group/custom-robot-access',
  wecom: 'https://guole.fun/posts/626/',
  wecombot: 'https://developer.work.weixin.qq.com/document/path/91770',
  bark: 'https://github.com/Finb/Bark',
  gocqhttp: 'https://docs.go-cqhttp.org/api/',
  onebot: 'https://docs.go-cqhttp.org/api/',
  atri: 'https://blog.tianli0.top/',
  pushdeer: 'https://www.pushdeer.com/',
  igot: 'https://push.hellyw.com/',
  telegram: 'https://core.telegram.org/bots',
  feishu: 'https://www.feishu.cn/hc/zh-CN/articles/360024984973',
  ifttt: 'https://ifttt.com/maker_webhooks',
  discord: 'https://discord.com/developers/docs/resources/webhook#execute-webhook',
  wxpusher: 'https://wxpusher.zjiecode.com/docs/#/',
}

const reloginUrlModeOptions = [
  { label: '不需要', value: 'none' },
  { label: '链接', value: 'qq_link' },
  { label: '二维码', value: 'qr_code' },
  { label: '二维码 + 链接', value: 'all' },
]

const currentChannelDocUrl = computed(() => {
  const key = String(localOffline.value.channel || '').trim().toLowerCase()
  return CHANNEL_DOCS[key] || ''
})

function openChannelDocs() {
  const url = currentChannelDocUrl.value
  if (!url)
    return
  window.open(url, '_blank', 'noopener,noreferrer')
}

const preferredSeedOptions = computed(() => {
  const options = [{ label: '自动选择', value: 0 }]
  if (seeds.value) {
    options.push(...seeds.value.map(seed => ({
      label: `${seed.requiredLevel}级 ${seed.name} (${seed.price}金)`,
      value: seed.seedId,
      disabled: seed.locked || seed.soldOut,
    })))
  }
  return options
})

const analyticsSortByMap: Record<string, string> = {
  max_exp: 'exp',
  max_fert_exp: 'fert',
  max_profit: 'profit',
  max_fert_profit: 'fert_profit',
}

const strategyPreviewLabel = ref<string | null>(null)

watchEffect(async () => {
  const strategy = localSettings.value.plantingStrategy
  if (strategy === 'preferred' || strategy === BAG_PRIORITY_STRATEGY) {
    strategyPreviewLabel.value = null
    return
  }
  if (!seeds.value || seeds.value.length === 0) {
    strategyPreviewLabel.value = null
    return
  }
  const available = seeds.value.filter(s => !s.locked && !s.soldOut)
  if (available.length === 0) {
    strategyPreviewLabel.value = '暂无可用种子'
    return
  }
  if (strategy === 'level') {
    const best = [...available].sort((a, b) => b.requiredLevel - a.requiredLevel)[0]
    strategyPreviewLabel.value = best ? `${best.requiredLevel}级 ${best.name}` : null
    return
  }
  const sortBy = analyticsSortByMap[strategy]
  if (sortBy) {
    try {
      const res = await api.get(`/api/analytics?sort=${sortBy}`)
      const rankings: any[] = res.data.ok ? (res.data.data || []) : []
      const availableIds = new Set(available.map(s => s.seedId))
      const match = rankings.find(r => availableIds.has(Number(r.seedId)))
      if (match) {
        const seed = available.find(s => s.seedId === Number(match.seedId))
        strategyPreviewLabel.value = seed ? `${seed.requiredLevel}级 ${seed.name}` : null
      }
      else {
        strategyPreviewLabel.value = '暂无匹配种子'
      }
    }
    catch {
      strategyPreviewLabel.value = null
    }
    return
  }

  strategyPreviewLabel.value = null
})

async function saveAccountSettings() {
  if (!currentAccountId.value)
    return

  const settingsPayload = buildAccountSettingsPayload()

  saving.value = true
  try {
    const res = await settingStore.saveSettings(currentAccountId.value, settingsPayload)
    if (res.ok) {
      showAlert('账号设置已保存')
    }
    else {
      showAlert(`保存失败: ${res.error}`, 'danger')
    }
  }
  finally {
    saving.value = false
  }
}

function buildAccountSettingsPayload(): AccountSettingsPayload {
  const next = JSON.parse(JSON.stringify(localSettings.value)) as AccountSettingsPayload
  next.automation.fertilizer_land_types = normalizeFertilizerLandTypes(next.automation.fertilizer_land_types)
  next.automation.friend_steal_blacklist = normalizeStealPlantBlacklist(next.automation.friend_steal_blacklist)
  next.automation.fertilizer_buy_max = Math.max(1, Math.min(10, Number.parseInt(String(next.automation.fertilizer_buy_max), 10) || 10))
  next.automation.fertilizer_buy_threshold = Math.max(0, Number.parseInt(String(next.automation.fertilizer_buy_threshold), 10) || 0)
  if (next.automation.fertilizer_buy_mode === 'unlimited' && next.automation.fertilizer_buy_type === 'both')
    next.automation.fertilizer_buy_type = 'organic'
  if (isBagPriorityStrategy.value && bagSeedsLoadedAccountId.value === currentAccountId.value)
    next.bagSeedPriority = mergeBagSeedPriority(next.bagSeedPriority, bagPrioritySeedSource.value)
  else
    next.bagSeedPriority = normalizeBagSeedPriority(next.bagSeedPriority)
  if (
    next.bagSeedFallbackStrategy === BAG_PRIORITY_STRATEGY
    || !bagSeedFallbackStrategyOptions.value.some(option => option.value === next.bagSeedFallbackStrategy)
  ) {
    next.bagSeedFallbackStrategy = DEFAULT_BAG_SEED_FALLBACK_STRATEGY
  }

  localSettings.value = JSON.parse(JSON.stringify(next))
  return next
}

function openSettingsSyncModal() {
  if (!currentAccountId.value) {
    showAlert('请先选择账号', 'danger')
    return
  }

  if (syncableAccounts.value.length === 0) {
    showAlert('当前没有可同步的其他账号', 'danger')
    return
  }

  settingsSyncMode.value = 'all'
  settingsSyncTargetIds.value = []
  settingsSyncModalVisible.value = true
}

function closeSettingsSyncModal() {
  if (settingsSyncSaving.value)
    return
  settingsSyncModalVisible.value = false
}

function setSettingsSyncMode(mode: 'all' | 'selected') {
  settingsSyncMode.value = mode
  if (mode === 'all')
    settingsSyncTargetIds.value = []
}

function toggleSettingsSyncTarget(accountId: string) {
  const normalizedId = String(accountId || '').trim()
  if (!normalizedId)
    return

  if (settingsSyncTargetIds.value.includes(normalizedId)) {
    settingsSyncTargetIds.value = settingsSyncTargetIds.value.filter(id => id !== normalizedId)
    return
  }

  settingsSyncTargetIds.value = [...settingsSyncTargetIds.value, normalizedId]
}

function selectAllSettingsSyncTargets() {
  settingsSyncTargetIds.value = syncableAccounts.value.map(account => String(account?.id || '')).filter(Boolean)
}

function clearSettingsSyncTargets() {
  settingsSyncTargetIds.value = []
}

function getSettingsSyncAccountName(account: any) {
  return String(account?.name || account?.nick || account?.id || '').trim()
}

async function handleSyncAccountSettings() {
  if (!currentAccountId.value)
    return

  if (settingsSyncMode.value === 'selected' && selectedSettingsSyncCount.value === 0) {
    showAlert('请至少选择一个目标账号', 'danger')
    return
  }

  const settingsPayload = buildAccountSettingsPayload()
  settingsSyncSaving.value = true
  try {
    const res = await settingStore.syncSettings(currentAccountId.value, {
      targetMode: settingsSyncMode.value,
      targetAccountIds: settingsSyncTargetIds.value,
      settings: settingsPayload,
    })

    if (!res.ok) {
      showAlert(`同步失败: ${res.error || '未知错误'}`, 'danger')
      return
    }

    const targetAccounts = Array.isArray(res.data?.targetAccounts) ? res.data.targetAccounts : []
    const previewNames = targetAccounts.map(account => account.name || account.id).slice(0, 5).join('、')
    const suffix = targetAccounts.length > 5 ? ` 等 ${targetAccounts.length} 个账号` : ''
    const detailText = previewNames ? `：${previewNames}${suffix}` : ''
    settingsSyncModalVisible.value = false
    showAlert(`已将当前页面的策略与自动控制同步到 ${targetAccounts.length} 个账号${detailText}`)
  }
  finally {
    settingsSyncSaving.value = false
  }
}

async function handleChangePassword() {
  if (!passwordForm.value.old || !passwordForm.value.new) {
    showAlert('请填写完整', 'danger')
    return
  }
  if (passwordForm.value.new !== passwordForm.value.confirm) {
    showAlert('两次密码输入不一致', 'danger')
    return
  }
  if (passwordForm.value.new.length < 4) {
    showAlert('密码长度至少4位', 'danger')
    return
  }

  passwordSaving.value = true
  try {
    const res = await settingStore.changeAdminPassword(passwordForm.value.old, passwordForm.value.new)

    if (res.ok) {
      showAlert('密码修改成功')
      passwordForm.value = { old: '', new: '', confirm: '' }
    }
    else {
      showAlert(`修改失败: ${res.error || '未知错误'}`, 'danger')
    }
  }
  finally {
    passwordSaving.value = false
  }
}

// 获取密码认证状态
async function fetchPasswordAuthStatus() {
  try {
    const { data } = await api.get('/api/admin/password-auth-status')
    if (data && data.ok) {
      passwordAuthDisabled.value = data.data.disabled
    }
  }
  catch (e) {
    console.error('获取密码认证状态失败:', e)
  }
}

// 切换密码认证状态
async function handleTogglePasswordAuth() {
  passwordAuthLoading.value = true
  try {
    const { data } = await api.post('/api/admin/toggle-password-auth', {
      disabled: !passwordAuthDisabled.value,
    })

    if (data && data.ok) {
      passwordAuthDisabled.value = data.data.disabled
      showAlert(passwordAuthDisabled.value ? '已禁用密码认证' : '已启用密码认证')
    }
    else {
      showAlert(`操作失败: ${data?.error || '未知错误'}`, 'danger')
    }
  }
  catch (e: any) {
    showAlert(`操作失败: ${e?.response?.data?.error || e?.message || '未知错误'}`, 'danger')
  }
  finally {
    passwordAuthLoading.value = false
  }
}

async function handleSaveQrLogin() {
  qrSaving.value = true
  try {
    const res = await settingStore.saveQrLoginConfig(localQrLogin.value)
    if (res.ok) {
      showAlert('二维码接口设置已保存')
    }
    else {
      showAlert(`保存失败: ${res.error || '未知错误'}`, 'danger')
    }
  }
  finally {
    qrSaving.value = false
  }
}
async function handleSaveRuntimeClient() {
  runtimeClientSaving.value = true
  try {
    const res = await settingStore.saveRuntimeClientConfig(localRuntimeClient.value as any)
    if (res.ok) {
      showAlert('运行时连接配置已保存，运行中账号将自动重连生效')
    }
    else {
      showAlert(`保存失败: ${res.error || '未知错误'}`, 'danger')
    }
  }
  finally {
    runtimeClientSaving.value = false
  }
}

async function handleSaveOffline() {
  localOffline.value.offlineDeleteSec = Math.max(1, Number.parseInt(String(localOffline.value.offlineDeleteSec), 10) || 1)
  localOffline.value.offlineDeleteEnabled = !!localOffline.value.offlineDeleteEnabled

  offlineSaving.value = true
  try {
    const res = await settingStore.saveOfflineConfig(localOffline.value)

    if (res.ok) {
      showAlert('下线提醒设置已保存')
    }
    else {
      showAlert(`保存失败: ${res.error || '未知错误'}`, 'danger')
    }
  }
  finally {
    offlineSaving.value = false
  }
}

async function handleTestOffline() {
  offlineTesting.value = true
  try {
    const { data } = await api.post('/api/settings/offline-reminder/test', localOffline.value)
    if (data?.ok) {
      showAlert('测试消息发送成功')
    }
    else {
      showAlert(`测试失败: ${data?.error || '未知错误'}`, 'danger')
    }
  }
  catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '请求失败'
    showAlert(`测试失败: ${msg}`, 'danger')
  }
  finally {
    offlineTesting.value = false
  }
}
</script>

<template>
  <div class="settings-page">
    <div v-if="loading" class="py-4 text-center text-gray-500">
      <div class="i-svg-spinners-ring-resize mx-auto mb-2 text-2xl" />
      <p>加载中...</p>
    </div>

    <div v-else class="grid grid-cols-1 mt-12 gap-4 text-sm lg:grid-cols-2">
      <!-- Card 1: Strategy & Automation -->
      <div v-if="currentAccountId" class="card h-full flex flex-col rounded-lg bg-white shadow dark:bg-gray-800">
        <!-- Strategy Header -->
        <div class="border-b bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
          <h3 class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
            <div class="i-fas-cogs" />
            策略设置
            <span v-if="currentAccountName" class="ml-2 text-sm text-gray-500 font-normal dark:text-gray-400">
              ({{ currentAccountName }})
            </span>
          </h3>
        </div>

        <!-- Strategy Content -->
        <div class="p-4 space-y-3">
          <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
            <BaseSelect
              v-model="localSettings.plantingStrategy"
              label="种植策略"
              :options="plantingStrategyOptions"
            />
            <BaseSelect
              v-if="localSettings.plantingStrategy === 'preferred'"
              v-model="localSettings.preferredSeedId"
              label="优先种植种子"
              :options="preferredSeedOptions"
            />
            <BaseSelect
              v-else-if="isBagPriorityStrategy"
              v-model="localSettings.bagSeedFallbackStrategy"
              label="第二优先策略"
              :options="bagSeedFallbackStrategyOptions"
            />
            <!-- 预览区域：与 BaseSelect 同结构同样式，避免切换策略时布局跳动 -->
            <div v-else class="flex flex-col gap-1.5">
              <label class="text-sm text-gray-700 font-medium dark:text-gray-300">策略选种预览</label>
              <div
                class="w-full flex items-center justify-between border border-gray-200 rounded-lg bg-gray-50 px-3 py-2 text-gray-500 dark:border-gray-600 dark:bg-gray-800/50 dark:text-gray-400"
              >
                <span class="truncate">{{ strategyPreviewLabel ?? '加载中...' }}</span>
                <div class="i-carbon-chevron-down shrink-0 text-lg text-gray-400" />
              </div>
            </div>
          </div>

          <div v-if="isBagPriorityStrategy" class="border border-amber-200 rounded-lg bg-amber-50/70 p-3 space-y-3 dark:border-amber-800/60 dark:bg-amber-900/10">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div class="text-sm text-amber-900 font-semibold dark:text-amber-200">
                  背包种子优先顺序
                </div>
                <p class="mt-1 text-xs text-amber-700/90 dark:text-amber-300/90">
                  先按下方顺序消耗背包中的 1x1 种子；背包种子不足时，再按“第二优先策略”补种。
                </p>
                <p v-if="skippedBagSeedCount > 0" class="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  已自动忽略 {{ skippedBagSeedCount }} 个非 1x1 种子，它们不会参与背包优先策略。
                </p>
              </div>
              <BaseButton
                variant="outline"
                size="sm"
                type="button"
                :disabled="bagPrioritySeedOptions.length === 0"
                @click="resetBagSeedPriority"
              >
                重置顺序
              </BaseButton>
            </div>

            <div
              v-if="bagSeedsLoading"
              class="flex items-center gap-2 border border-amber-200 rounded-lg bg-white/80 px-3 py-3 text-sm text-amber-700 dark:border-amber-700/60 dark:bg-gray-800/70 dark:text-amber-300"
            >
              <div class="i-svg-spinners-ring-resize text-base" />
              <span>正在加载背包种子...</span>
            </div>

            <div
              v-else-if="bagSeedsError"
              class="flex flex-wrap items-center justify-between gap-3 border border-red-200 rounded-lg bg-red-50 px-3 py-3 text-sm text-red-600 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-300"
            >
              <span>背包种子加载失败：{{ bagSeedsError }}</span>
              <BaseButton
                variant="outline"
                size="sm"
                type="button"
                @click="loadBagSeeds(true)"
              >
                重新加载
              </BaseButton>
            </div>

            <div
              v-else-if="bagPrioritySeedOptions.length === 0"
              class="border border-amber-300 rounded-lg border-dashed px-3 py-4 text-sm text-amber-700 dark:border-amber-700/60 dark:text-amber-300"
            >
              当前背包没有可用于背包优先策略的 1x1 种子。
            </div>

            <div v-else class="space-y-2">
              <div
                v-for="(seed, index) in bagPrioritySeedOptions"
                :key="seed.seedId"
                class="flex flex-wrap cursor-move items-center justify-between gap-3 border border-amber-200 rounded-lg bg-white/90 px-3 py-3 transition-colors dark:border-amber-800/60 dark:bg-gray-800/70"
                :class="{
                  'border-amber-400 bg-amber-100/70 dark:border-amber-500 dark:bg-amber-900/20': dropTargetBagSeedId === seed.seedId,
                  'opacity-60': draggingBagSeedId === seed.seedId,
                }"
                draggable="true"
                @dragstart="startBagSeedDrag(seed.seedId, $event)"
                @dragover="dragOverBagSeed(seed.seedId, $event)"
                @drop="dropBagSeed(seed.seedId, $event)"
                @dragend="endBagSeedDrag"
              >
                <div class="min-w-0 flex items-center gap-3">
                  <div class="h-8 w-8 flex shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200">
                    ≡
                  </div>
                  <div class="h-8 w-8 flex shrink-0 items-center justify-center rounded-full bg-amber-100 text-sm text-amber-800 font-semibold dark:bg-amber-500/20 dark:text-amber-200">
                    {{ index + 1 }}
                  </div>
                  <img
                    v-if="seed.image"
                    :src="seed.image"
                    :alt="seed.name"
                    class="h-10 w-10 shrink-0 rounded-lg object-cover ring-1 ring-amber-200 dark:ring-amber-700/60"
                  >
                  <div
                    v-else
                    class="h-10 w-10 flex shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-500"
                  >
                    <div class="i-carbon-image" />
                  </div>
                  <div class="min-w-0">
                    <div class="truncate text-sm text-gray-900 font-medium dark:text-gray-100">
                      {{ seed.name }}
                    </div>
                    <div class="text-xs text-gray-500 dark:text-gray-400">
                      Seed ID: {{ seed.seedId }} · Lv.{{ seed.requiredLevel }} · 数量 {{ seed.count }}
                    </div>
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <BaseButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    :disabled="index === 0"
                    @click="moveBagSeed(seed.seedId, -1)"
                  >
                    上移
                  </BaseButton>
                  <BaseButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    :disabled="index === bagPrioritySeedOptions.length - 1"
                    @click="moveBagSeed(seed.seedId, 1)"
                  >
                    下移
                  </BaseButton>
                </div>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
            <BaseInput
              v-model.number="localSettings.intervals.farmMin"
              label="农场巡查最小 (秒)"
              type="number"
              min="1"
              max="86400"
            />
            <BaseInput
              v-model.number="localSettings.intervals.farmMax"
              label="农场巡查最大 (秒)"
              type="number"
              min="1"
              max="86400"
            />
            <BaseInput
              v-model.number="localSettings.intervals.friendMin"
              label="好友巡查最小 (秒)"
              type="number"
              min="1"
              max="86400"
            />
            <BaseInput
              v-model.number="localSettings.intervals.friendMax"
              label="好友巡查最大 (秒)"
              type="number"
              min="1"
              max="86400"
            />
          </div>

          <div class="mt-4 flex flex-wrap items-center gap-4 border-t pt-3 dark:border-gray-700">
            <BaseSwitch
              v-model="localSettings.friendQuietHours.enabled"
              label="启用静默时段"
            />
            <div class="flex items-center gap-2">
              <BaseInput
                v-model="localSettings.friendQuietHours.start"
                type="time"
                class="w-24"
                :disabled="!localSettings.friendQuietHours.enabled"
              />
              <span class="text-gray-500">-</span>
              <BaseInput
                v-model="localSettings.friendQuietHours.end"
                type="time"
                class="w-24"
                :disabled="!localSettings.friendQuietHours.enabled"
              />
            </div>
          </div>
        </div>

        <!-- Auto Control Header -->
        <div class="border-b border-t bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
          <h3 class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
            <div class="i-fas-toggle-on" />
            自动控制
          </h3>
        </div>

        <!-- Auto Control Content -->
        <div class="flex-1 p-4 space-y-4">
          <!-- Switches Grid -->
          <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
            <BaseSwitch v-model="localSettings.automation.farm" label="自动种植收获" />
            <BaseSwitch v-model="localSettings.automation.farm_manage" label="自动打理农场" />
            <BaseSwitch v-model="localSettings.automation.task" label="自动做任务" />
            <BaseSwitch v-model="localSettings.automation.sell" label="自动卖果实" />
            <BaseSwitch v-model="localSettings.automation.friend" label="自动好友互动" />
            <BaseSwitch v-model="localSettings.automation.farm_push" label="推送触发巡田" />
            <BaseSwitch v-model="localSettings.automation.land_upgrade" label="自动升级土地" />
            <BaseSwitch v-model="localSettings.automation.email" label="自动领取邮件" />
            <BaseSwitch v-model="localSettings.automation.free_gifts" label="自动商城礼包" />
            <BaseSwitch v-model="localSettings.automation.share_reward" label="自动分享奖励" />
            <BaseSwitch v-model="localSettings.automation.vip_gift" label="自动VIP礼包" />
            <BaseSwitch v-model="localSettings.automation.month_card" label="自动月卡奖励" />
            <BaseSwitch v-model="localSettings.automation.open_server_gift" label="自动开服红包" />
            <BaseSwitch v-model="localSettings.automation.fertilizer_gift" label="自动填充化肥" />
            <BaseSwitch v-model="localSettings.automation.fertilizer_buy" label="自动购买化肥" />
          </div>

          <!-- 自动购买化肥子配置 -->
          <div v-if="localSettings.automation.fertilizer_buy" class="border border-cyan-200 rounded bg-cyan-50/60 p-3 dark:border-cyan-800/60 dark:bg-cyan-900/10">
            <div class="mb-2 text-sm text-cyan-800 font-medium dark:text-cyan-300">
              购买化肥配置
            </div>
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <BaseSelect
                v-model="localSettings.automation.fertilizer_buy_type"
                label="购买种类"
                :options="fertilizerBuyTypeOptions"
              />
              <BaseSelect
                v-model="localSettings.automation.fertilizer_buy_mode"
                label="购买条件"
                :options="fertilizerBuyModeOptions"
              />
            </div>
            <div class="grid grid-cols-1 mt-3 gap-3 md:grid-cols-2">
              <BaseInput
                v-model.number="localSettings.automation.fertilizer_buy_max"
                label="本轮最多购买总数（个）"
                type="number"
                min="1"
                max="10"
              />
              <BaseInput
                v-if="localSettings.automation.fertilizer_buy_mode === 'threshold'"
                v-model.number="localSettings.automation.fertilizer_buy_threshold"
                label="容器低于此小时数时购买"
                type="number"
                min="0"
              />
            </div>
            <p v-if="localSettings.automation.fertilizer_buy_mode === 'threshold'" class="mt-2 text-xs text-cyan-700 dark:text-cyan-300">
              阈值为 0 表示容器空了再买。
            </p>
            <p v-if="localSettings.automation.fertilizer_buy_mode === 'unlimited'" class="mt-2 text-xs text-amber-600 dark:text-amber-400">
              无限购买模式下不能同时选择两种化肥
            </p>
          </div>

          <!-- Sub-controls -->
          <div class="flex flex-wrap gap-4 rounded bg-emerald-50 p-2 text-sm dark:bg-emerald-900/20" :class="{ 'opacity-50 pointer-events-none': farmDisabled }">
            <BaseSwitch v-model="localSettings.automation.farm_water" label="自动浇水" :disabled="farmDisabled" />
            <BaseSwitch v-model="localSettings.automation.farm_bug" label="自动除虫" :disabled="farmDisabled" />
            <BaseSwitch v-model="localSettings.automation.farm_weed" label="自动除草" :disabled="farmDisabled" />
          </div>

          <div class="flex flex-wrap gap-4 rounded bg-blue-50 p-2 text-sm dark:bg-blue-900/20" :class="{ 'opacity-50 pointer-events-none': friendDisabled }">
            <BaseSwitch v-model="localSettings.automation.friend_steal" label="自动偷菜" :disabled="friendDisabled" />
            <BaseSwitch v-model="localSettings.automation.friend_help" label="自动帮忙" :disabled="friendDisabled" />
            <BaseSwitch v-model="localSettings.automation.friend_bad" label="自动捣乱" :disabled="friendDisabled" />
            <BaseSwitch v-model="localSettings.automation.friend_help_exp_limit" label="经验上限停止帮忙" :disabled="friendDisabled" />
          </div>

          <!-- Steal Crop Blacklist + Fertilizer -->
          <div class="space-y-3">
            <div class="border border-blue-200 rounded-lg bg-blue-50/70 p-3 text-gray-800 shadow-sm dark:border-blue-500/50 dark:bg-[#17243a] dark:text-white">
              <div class="mb-1 flex items-center justify-between gap-3">
                <div class="min-w-0 flex items-center gap-2">
                  <div class="h-9 w-9 flex items-center justify-center border border-blue-300/70 rounded-lg bg-white/90 dark:border-blue-500/40 dark:bg-blue-500/20">
                    <div class="i-carbon-filter text-xl text-blue-700 dark:text-blue-200" />
                  </div>
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <div class="truncate text-base font-semibold">
                        排除作物
                      </div>
                      <div class="border border-blue-300 rounded-full bg-white/95 px-2 py-0.5 text-xs text-blue-700 shadow-sm dark:border-blue-300/60 dark:bg-blue-500/15 dark:text-blue-100">
                        <span class="font-semibold">{{ stealBlacklistCount }} / {{ stealCropOptions.length }}</span>
                      </div>
                    </div>
                    <p class="text-xs text-blue-700/90 dark:text-blue-200/85">
                      勾选后，自动偷菜会跳过这些作物；
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  class="h-9 w-9 flex items-center justify-center border border-blue-300/70 rounded-lg bg-white/90 text-blue-700 transition dark:border-blue-500/40 dark:bg-blue-500/20 hover:bg-blue-100 dark:text-blue-100 dark:hover:bg-blue-500/30"
                  :aria-expanded="!stealBlacklistCollapsed"
                  @click="stealBlacklistCollapsed = !stealBlacklistCollapsed"
                >
                  <div
                    class="i-carbon-chevron-down text-lg transition-transform"
                    :class="stealBlacklistCollapsed ? '' : 'rotate-180'"
                  />
                </button>
              </div>

              <div v-if="!stealBlacklistCollapsed">
                <div class="my-2 border-t border-blue-200/80 dark:border-blue-400/30" />

                <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div class="text-xs text-blue-700/90 dark:text-blue-200/90">
                    支持按作物名或 seedid 搜索
                  </div>
                  <div class="flex items-center justify-end gap-2">
                    <BaseButton
                      variant="outline"
                      size="sm"
                      class="!border-blue-300 !text-blue-700 dark:!border-blue-400/70 hover:!bg-blue-100 dark:!text-blue-100 dark:hover:!bg-blue-500/20"
                      :disabled="stealBlacklistCount >= stealCropOptions.length"
                      @click="filterUnselectedStealCrops"
                    >
                      排除筛选
                    </BaseButton>
                    <BaseButton
                      variant="ghost"
                      size="sm"
                      class="!text-blue-700 hover:!bg-blue-100 dark:!text-blue-100 dark:hover:!bg-blue-500/20"
                      :disabled="!stealBlacklistSearch && !onlyShowUnselectedStealCrops"
                      @click="clearStealFilter"
                    >
                      清空
                    </BaseButton>
                  </div>
                </div>

                <div class="relative mb-2">
                  <div class="pointer-events-none absolute left-3 top-1/2 text-base text-blue-500/70 -translate-y-1/2 dark:text-blue-200/70">
                    <div class="i-carbon-search" />
                  </div>
                  <input
                    v-model="stealBlacklistSearch"
                    type="text"
                    placeholder="搜索作物名或 Seed ID"
                    class="w-full border border-blue-200 rounded-lg bg-white py-2 pl-9 pr-3 text-sm text-gray-700 outline-none dark:border-blue-400/40 focus:border-blue-400 dark:bg-[#1c2b45] dark:text-blue-50 placeholder:text-gray-400 focus:ring-2 focus:ring-blue-300/20 dark:focus:border-blue-300/70 dark:placeholder:text-blue-200/50"
                  >
                </div>

                <div v-if="stealCropOptions.length > 0">
                  <div
                    v-if="filteredStealCropOptions.length > 0"
                    class="grid grid-cols-1 max-h-56 gap-2 overflow-y-auto pr-1 lg:grid-cols-3 sm:grid-cols-2"
                  >
                    <button
                      v-for="crop in filteredStealCropOptions"
                      :key="crop.plantId"
                      type="button"
                      class="w-full flex cursor-pointer items-center gap-2 border rounded bg-white px-2 py-1.5 text-left text-xs text-gray-700 transition dark:bg-gray-800 dark:text-gray-300"
                      :class="isCropBlacklisted(crop.plantId)
                        ? 'border-blue-500 ring-1 ring-blue-300/70 dark:border-blue-400 dark:ring-blue-700/50'
                        : 'border-gray-200 hover:border-blue-300 dark:border-gray-700 dark:hover:border-blue-700'"
                      :aria-pressed="isCropBlacklisted(crop.plantId)"
                      @click="toggleStealBlacklistCrop(crop.plantId)"
                    >
                      <img
                        v-if="crop.image"
                        :src="crop.image"
                        :alt="crop.name"
                        class="h-[1.8rem] w-[1.8rem] rounded object-cover"
                      >
                      <div v-else class="h-[1.8rem] w-[1.8rem] flex items-center justify-center rounded bg-gray-100 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                        <div class="i-carbon-image" />
                      </div>
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-xs font-medium">
                          {{ crop.name }}
                        </div>
                        <div class="text-[11px] text-gray-500 dark:text-gray-400">
                          Seed ID: {{ crop.seedId === null ? '?' : crop.seedId }}   Lv.{{ crop.level === null ? '?' : crop.level }}
                        </div>
                      </div>
                    </button>
                  </div>
                  <div v-else class="rounded bg-white px-2 py-2 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                    未找到匹配作物，请调整关键词后重试。
                  </div>
                </div>
                <div v-else class="rounded bg-white px-2 py-2 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                  暂无可选作物，请先等待种子列表加载完成。
                </div>
              </div>
            </div>
            <div class="border border-amber-200 rounded bg-amber-50/60 p-3 dark:border-amber-800/60 dark:bg-amber-900/10">
              <div class="mb-2 text-sm text-amber-800 font-medium dark:text-amber-300">
                施肥范围
              </div>
              <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
                <label
                  v-for="option in fertilizerLandTypeOptions"
                  :key="option.value"
                  class="flex cursor-pointer items-center gap-1.5 rounded bg-white px-2 py-1 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                >
                  <input
                    v-model="localSettings.automation.fertilizer_land_types"
                    :value="option.value"
                    type="checkbox"
                    class="h-3.5 w-3.5"
                  >
                  <span>{{ option.label }}</span>
                </label>
              </div>
              <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
                施肥前会优先按土地类型过滤，仅对命中范围的地块执行施肥策略。
              </p>
            </div>
            <div class="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
              <BaseSelect
                v-model="localSettings.automation.fertilizer"
                label="施肥策略"
                class="w-full"
                :options="fertilizerOptions"
              />
              <BaseSwitch
                v-model="localSettings.automation.fertilizer_multi_season"
                label="多季补肥"
                class="md:mb-2"
              />
            </div>
          </div>
        </div>

        <!-- Save Button -->
        <div class="mt-auto flex flex-col gap-3 border-t bg-gray-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-gray-700 dark:bg-gray-900/50">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            当前页策略可一键同步到其他账号。
          </div>
          <div class="flex justify-end gap-2">
            <BaseButton
              variant="secondary"
              size="sm"
              :disabled="saving || !currentAccountId || syncableAccounts.length === 0"
              @click="openSettingsSyncModal"
            >
              同步到其他账号
            </BaseButton>
            <BaseButton
              variant="primary"
              size="sm"
              :loading="saving"
              @click="saveAccountSettings"
            >
              保存策略与自动控制
            </BaseButton>
          </div>
        </div>
      </div>

      <div v-else class="card flex flex-col items-center justify-center gap-4 rounded-lg bg-white p-12 text-center shadow dark:bg-gray-800">
        <div class="rounded-full bg-gray-50 p-4 dark:bg-gray-700/50">
          <div class="i-carbon-settings-adjust text-4xl text-gray-400 dark:text-gray-500" />
        </div>
        <div class="max-w-xs">
          <h3 class="text-lg text-gray-900 font-medium dark:text-gray-100">
            需要登录账号
          </h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            请先登录账号以配置策略和自动化选项。
          </p>
        </div>
      </div>

      <!-- Card 2: System Settings (Password & Offline) -->
      <div class="card h-full flex flex-col rounded-lg bg-white shadow dark:bg-gray-800">
        <!-- Password Header -->
        <div class="border-b bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
          <h3 class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
            <div class="i-carbon-password" />
            管理密码
          </h3>
        </div>

        <!-- Password Content -->
        <div class="p-4 space-y-3">
          <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
            <BaseInput
              v-model="passwordForm.old"
              label="当前密码"
              type="password"
              placeholder="当前管理密码"
            />
            <BaseInput
              v-model="passwordForm.new"
              label="新密码"
              type="password"
              placeholder="至少 4 位"
            />
            <BaseInput
              v-model="passwordForm.confirm"
              label="确认新密码"
              type="password"
              placeholder="再次输入新密码"
            />
          </div>

          <div class="flex items-center justify-between pt-1">
            <p class="text-xs text-gray-500">
              建议修改默认密码 (admin)
            </p>
            <BaseButton
              variant="primary"
              size="sm"
              :loading="passwordSaving"
              @click="handleChangePassword"
            >
              修改管理密码
            </BaseButton>
          </div>

          <!-- 取消密码访问功能 -->
          <div class="mt-4 border-t pt-4 dark:border-gray-700">
            <div class="mb-3 flex items-center justify-between">
              <div>
                <h4 class="text-sm text-gray-900 font-medium dark:text-gray-100">
                  取消密码访问
                </h4>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                  开启后无需输入管理员密码即可直接进入界面
                </p>
              </div>
              <BaseSwitch
                :model-value="passwordAuthDisabled"
                :disabled="passwordAuthLoading"
                @update:model-value="handleTogglePasswordAuth"
              />
            </div>

            <div v-if="passwordAuthDisabled" class="mt-2 rounded bg-orange-50 p-2 text-xs text-orange-700 dark:bg-orange-900/20 dark:text-orange-300">
              <div class="flex items-center gap-1">
                <div class="i-carbon-warning-alt" />
                <span>安全提醒：已禁用密码认证，任何人都可以访问管理面板</span>
              </div>
            </div>
          </div>
        </div>

        <!-- QR Login Header -->
        <div class="border-b border-t bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
          <h3 class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
            <div class="i-carbon-connection-signal" />
            运行时连接配置
          </h3>
        </div>

        <!-- Runtime Client Content -->
        <div class="p-4 space-y-3">
          <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
            <BaseInput
              v-model="localRuntimeClient.serverUrl"
              label="服务器 WS 地址"
              type="text"
              placeholder="wss://.../ws"
            />
            <BaseInput
              v-model="localRuntimeClient.clientVersion"
              label="游戏版本号"
              type="text"
              placeholder="例如: 1.6.2.18_20260227"
            />
          </div>

          <BaseSelect
            v-model="localRuntimeClient.os"
            label="系统 (os)"
            :options="[{ label: 'iOS', value: 'iOS' }, { label: 'Android', value: 'Android' }]"
          />

          <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
            <BaseInput
              v-model="localRuntimeClient.device_info.sys_software"
              label="系统版本号"
              type="text"
              placeholder="例如: iOS 26.2.1"
            />
            <BaseInput
              v-model="localRuntimeClient.device_info.network"
              label="网络类型"
              type="text"
              placeholder="例如: wifi"
            />
          </div>

          <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
            <BaseInput
              v-model="localRuntimeClient.device_info.memory"
              label="内存大小（单位MB）"
              type="text"
              placeholder="例如: 7672"
            />
            <BaseInput
              v-model="localRuntimeClient.device_info.device_id"
              label="设备ID"
              type="text"
              placeholder="例如: iPhone X<iPhone18,3>"
            />
          </div>

          <p class="text-xs text-gray-500 dark:text-gray-400">
            保存后，运行中的账号会自动重连以生效。
          </p>

          <div class="flex justify-end">
            <BaseButton
              variant="primary"
              size="sm"
              :loading="runtimeClientSaving"
              @click="handleSaveRuntimeClient"
            >
              保存运行时连接配置
            </BaseButton>
          </div>
        </div>

        <!-- QR Login Header -->
        <div class="border-b border-t bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
          <h3 class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
            <div class="i-carbon-qr-code" />
            二维码登录接口
          </h3>
        </div>

        <!-- QR Login Content -->
        <div class="p-4 space-y-3">
          <BaseInput
            v-model="localQrLogin.apiDomain"
            label="二维码接口域名"
            type="text"
            placeholder="q.qq.com"
          />
          <p class="text-xs text-gray-500 dark:text-gray-400">
            仅影响后端调用二维码相关接口的域名，前端仍使用 /api/qr/create 与 /api/qr/check。
          </p>
          <div class="flex justify-end">
            <BaseButton
              variant="primary"
              size="sm"
              :loading="qrSaving"
              @click="handleSaveQrLogin"
            >
              保存二维码接口设置
            </BaseButton>
          </div>
        </div>
        <!-- Offline Header -->
        <div class="border-b bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
          <h3 class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
            <div class="i-carbon-notification" />
            下线提醒
          </h3>
        </div>

        <!-- Offline Content -->
        <div class="flex-1 p-4 space-y-3">
          <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between">
                <span class="text-sm text-gray-700 font-medium dark:text-gray-300">推送渠道</span>
                <BaseButton
                  variant="text"
                  size="sm"
                  :disabled="!currentChannelDocUrl"
                  @click="openChannelDocs"
                >
                  官网
                </BaseButton>
              </div>
              <BaseSelect
                v-model="localOffline.channel"
                :options="channelOptions"
              />
            </div>
            <BaseSelect
              v-model="localOffline.reloginUrlMode"
              label="重登录链接"
              :options="reloginUrlModeOptions"
            />
          </div>

          <BaseInput
            v-model="localOffline.endpoint"
            label="接口地址"
            type="text"
            :disabled="localOffline.channel !== 'webhook' && localOffline.channel !== 'custom_request'"
          />

          <BaseInput
            v-model="localOffline.token"
            label="Token"
            type="text"
            placeholder="接收端 token"
          />

          <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
            <BaseInput
              v-model="localOffline.title"
              label="标题"
              type="text"
              placeholder="提醒标题"
            />
            <div class="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
              <BaseInput
                v-model.number="localOffline.offlineDeleteSec"
                label="离线删除账号 (秒)"
                type="number"
                min="1"
                placeholder="默认 1"
              />
              <BaseSwitch
                v-model="localOffline.offlineDeleteEnabled"
                label="启用离线删号"
                class="md:mb-2"
              />
            </div>
          </div>

          <BaseInput
            v-model="localOffline.msg"
            label="内容"
            type="text"
            placeholder="提醒内容"
          />

          <template v-if="localOffline.channel === 'custom_request'">
            <BaseTextarea
              v-model="localOffline.custom_headers"
              label="Headers (严格 JSON)"
              placeholder="例如: {&quot;Content-Type&quot;: &quot;application/json&quot;, &quot;Authorization&quot;: &quot;Bearer TOKEN&quot;}"
            />
            <BaseTextarea
              v-model="localOffline.custom_body"
              label="Body (严格 JSON, 占位符支持 {{title}}（标题） {{content}}（内容）)"
              placeholder="例如: { &quot;title&quot;: &quot;{{title}}&quot;, &quot;message&quot;: &quot;{{content}}&quot; }"
            />
          </template>

          <!-- Save Offline Button -->
          <div class="flex justify-end gap-2 pt-3">
            <BaseButton
              variant="secondary"
              size="sm"
              :loading="offlineTesting"
              :disabled="offlineSaving"
              @click="handleTestOffline"
            >
              测试通知
            </BaseButton>
            <BaseButton
              variant="primary"
              size="sm"
              :loading="offlineSaving"
              :disabled="offlineTesting"
              @click="handleSaveOffline"
            >
              保存下线提醒设置
            </BaseButton>
          </div>
        </div>

        <!-- Token Info Header -->
        <div class="border-t bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
          <h3 class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
            <div class="i-carbon-code" />
            请求参数信息
          </h3>
        </div>

        <!-- Token Info Content -->
        <div class="p-4 space-y-3">
          <div class="flex items-center gap-2">
            <input
              type="text"
              :value="token"
              readonly
              class="flex-1 border border-gray-200 rounded-lg bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            >
            <BaseButton
              v-if="token !== '未登录'"
              variant="secondary"
              size="sm"
              @click="copyToClipboard(token)"
            >
              <div class="i-carbon-copy mr-1" />
              复制
            </BaseButton>
          </div>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            x-admin-token 用于API请求认证，复制后可用于第三方工具调用接口。
          </p>
        </div>
      </div>
    </div>

    <ConfirmModal
      :show="modalVisible"
      :title="modalConfig.title"
      :message="modalConfig.message"
      :type="modalConfig.type"
      :is-alert="modalConfig.isAlert"
      confirm-text="知道了"
      @confirm="modalVisible = false"
      @cancel="modalVisible = false"
    />

    <div
      v-if="settingsSyncModalVisible"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      @click="closeSettingsSyncModal"
    >
      <div class="max-h-[85vh] max-w-2xl w-full overflow-y-auto rounded-xl bg-white shadow-2xl dark:bg-gray-800" @click.stop>
        <div class="border-b px-5 py-4 dark:border-gray-700">
          <div class="flex items-start justify-between gap-4">
            <div>
              <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
                同步账号设置
              </h3>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                将当前账号「{{ currentAccountName || currentAccountId }}」页面上的策略与自动控制同步到其他账号。
              </p>
            </div>
            <button
              class="rounded p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              :disabled="settingsSyncSaving"
              @click="closeSettingsSyncModal"
            >
              <div class="i-carbon-close text-lg" />
            </button>
          </div>
        </div>

        <div class="px-5 py-4 space-y-4">
          <div class="rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-600 dark:bg-gray-900/50 dark:text-gray-300">
            只会同步“策略与自动控制”这部分，不会影响运行时连接、二维码接口、下线提醒等全局设置。
          </div>

          <div class="flex flex-wrap gap-2">
            <button
              class="rounded-full px-3 py-1.5 text-sm transition"
              :class="settingsSyncMode === 'all'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'"
              @click="setSettingsSyncMode('all')"
            >
              同步到全部账号
            </button>
            <button
              class="rounded-full px-3 py-1.5 text-sm transition"
              :class="settingsSyncMode === 'selected'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'"
              @click="setSettingsSyncMode('selected')"
            >
              多选账号同步
            </button>
          </div>

          <div class="text-sm text-gray-500 dark:text-gray-400">
            {{ settingsSyncSummaryText }}
          </div>

          <div v-if="settingsSyncMode === 'selected'" class="space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="text-sm text-gray-700 font-medium dark:text-gray-200">
                目标账号
              </div>
              <div class="flex gap-2">
                <BaseButton
                  variant="text"
                  size="sm"
                  @click="selectAllSettingsSyncTargets"
                >
                  全选
                </BaseButton>
                <BaseButton
                  variant="text"
                  size="sm"
                  @click="clearSettingsSyncTargets"
                >
                  清空
                </BaseButton>
              </div>
            </div>

            <div class="max-h-72 overflow-y-auto rounded-lg bg-gray-50 p-3 space-y-2 dark:bg-gray-900/50">
              <label
                v-for="account in syncableAccounts"
                :key="account.id"
                class="flex cursor-pointer items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 transition dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700/70"
              >
                <div class="min-w-0 flex items-center gap-3">
                  <input
                    :checked="settingsSyncTargetIds.includes(String(account.id))"
                    type="checkbox"
                    class="h-4 w-4"
                    @change="toggleSettingsSyncTarget(String(account.id))"
                  >
                  <div class="min-w-0">
                    <div class="truncate text-sm text-gray-800 font-medium dark:text-gray-100">
                      {{ getSettingsSyncAccountName(account) }}
                    </div>
                    <div class="truncate text-xs text-gray-400">
                      ID {{ account.id }}
                    </div>
                  </div>
                </div>
                <span
                  v-if="getPlatformLabel(account.platform)"
                  class="shrink-0 rounded-full px-2 py-0.5 text-xs"
                  :class="getPlatformClass(account.platform)"
                >
                  {{ getPlatformLabel(account.platform) }}
                </span>
              </label>
            </div>
          </div>
        </div>

        <div class="flex items-center justify-end gap-2 border-t px-5 py-4 dark:border-gray-700">
          <BaseButton
            variant="secondary"
            size="sm"
            :disabled="settingsSyncSaving"
            @click="closeSettingsSyncModal"
          >
            取消
          </BaseButton>
          <BaseButton
            variant="primary"
            size="sm"
            :disabled="settingsSyncSaving || (settingsSyncMode === 'selected' && selectedSettingsSyncCount === 0)"
            :loading="settingsSyncSaving"
            @click="handleSyncAccountSettings"
          >
            开始同步
          </BaseButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="postcss">
/* Custom styles if needed */
</style>
