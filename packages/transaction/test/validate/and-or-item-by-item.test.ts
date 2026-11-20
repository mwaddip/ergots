/**
 * Spends whose script is an `OR` over a collection: the block cost is for the items `OR` read, and an item of
 * another kind behind the deciding item refuses nothing.
 *
 * JVM (sigma-state 6.0.7): `OR.eval` (data/shared/src/main/scala/sigma/ast/trees.scala:199-214), its cost added
 * after the read (interpreter/shared/src/main/scala/sigmastate/interpreter/CErgoTreeEvaluator.scala:399-417).
 *
 * The three entries are JVM-blessed rows of SANTA at commit 0f2fc79, copied field by field; the nine headers, the
 * pre-header (block version 3, activated script version 2) and the parameters are the same in all three:
 *  - `vectors/transaction/v5/authored/and-or-item-by-item.json`
 *    `and-or-item-by-item-spend-OR-ladder-L129-k0-tv0-a2#127`: `sigmaProp(OR(<129 Booleans, the first true>))`;
 *  - the same file, `and-or-item-by-item-spend-OR-tuple-dKn-Byte0-tv0-a2#142`: `sigmaProp(OR((true, 0.toByte,
 *    false)))`;
 *  - `vectors/transaction/v5/authored/segregated-tuple.json` `segregated-tuple-OR-phColl-dKn-v0-a2#53`: the tuple
 *    `(true, 5, false)` inside a segregated collection constant, read through `ByIndex`.
 */
import { describe, it, expect } from 'vitest'
import { validateStateful } from '../../src/validate/stateful'
import { santaTxInputs, type SantaTxEntry } from './_santa-tx'

const HEADERS = [
  '03aebae7765c8d1c0349b735d31c1e66fcd2442e632049c461c55fb196c21d2b7e4d41efc816f855d9d6e3cab68be6453b1d7c9a5a815016bcecd68f05509dc194a36723709ba917c6d25a3d9affd01f6caabbee498db075fc83e3ab4ccc4137554594ba1b326d52cb4016a5920da9beffc00aa7048e145ac6cbac616c18de7d7e00c0fda7df97317fee7f826c9c972c1988ec589ae8a994a1c5dc3dbf2d5d473a586cf0ec631c3f07000000bf9440000000000279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f817989225fc410e1f522e',
  '03c3e91e4643c21b8a10313fb2357ce399bc4f593dccbd23048ab6de7bd9e9168d57e97c8d17edd231cd3615ab90e5f8dda56dfe980b3d04760f91b8795b7038f2caf1db5a8dab61a6a4527e0d6c86de887cba6ab6682ae1cb210ca8e6c547b6a29ac538923511ab00321d46b9340194aa0f2c802f1f2ac15edd6e3fb414ae95620080d4a0df9731525db7fb27f763c83d3010f310b818c0c2ee0f0d0c4172b6edc7f4008990208e07000000be9440000000000279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798b5c965dbe72a3e11',
  '03adb455ae16ef7d2d921eacb02f4111eb53b04666e05201c712edc6c6f09d71f2dff9fdef3f61dd893b676271eb3661558f128927f85a4a70288851cc01149523e6ee2d8927d125d07bf5f9d2f3627b9c916c0149f548f3750d0a94fffbfe1604fa61657937ba46b47ccb752740c8725df666a0b1fab1cdd878037140df797abe00c0aa99df9731b5aebfa58e19cb68652782616fbc65ee1f20ddfc5aa2d678049a0609097c463507000000bd9440000000000279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798b3683ebd96f50b61',
  '0346e3c0eda223dc8501715e13bb81620f4191a5eb045e38a26078368e687904186c89208914bdfcfa01fc6be432a09145619d0b6d93f903137039e7c33467c16f342ccf5f126b33581979958f159ed17c0dbd0bb646d680fc0cd8f5f916aba1804d82c0cb7f07ba596d009b868b05b6ef2604964cf50153f6ec600e16c6e01e5300808192df97316d1cb58448e2ca5c4f6a9c41fc290686259b7f26dc3c63c7c46f77e5900ec66007000000bc9440000000000279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f817983c4bf69345b88459',
  '03efc7b2c6f96ce26c3cae0441b056bf35b3b5fa4deea2aebf3c613f35dca19083c4f8942fef53cae03e6f4304a3e33f9e4de5af43b67170c91f32f8d4719646863e4677fdaec79fb86aad09c05041b4e07bd1b716e9b07dbe4cf55422be85beda604719bf6b5d4a1a144d687664337399e4490e963e38e8bf373a3575923717a800c0d78adf97317aa177ac41e27f9d5199e6eeb93d6f24ff70f991e2c5d04d983fd5ebdba188ef07000000bb9440000000000279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798bcee599c779fc0fa',
  '03099eff72d53c04ab766fba85960773e637ea8a2334aecd8fc8a4ed47fc5276a10213940327a4e1f84703e993eee4938cbf4d772a62742dce9b8ef37d9f4bb91d23ffdaa2516778331153d666aa732d2b4dccb569a8cfff97f2a88c1a2b4f25a0be18fdc6880b9316bf32a8e731a3067f713173a9093fd515cdd20ec6c644f2190080ae83df97319c64e04ff8b4d062710115604d79e00eedd94dffa317322541ec952895a30f5b07000000ba9440000000000279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f8179839f349029be38ce4',
  '03a1accb6cb15e6cc7af245f19c38b89502057d379dac46d17d81b02d1892366860f61445d623e935c28037c0ae3e4395b68ba2fc30082e8e47c262c618a520382f13a69ffc175cefaf7a81b9aa9e5eebd8176a0f5f6a9c55d55edaa15563a6da983323a723f95427ea84697dbcb6c2d34e9b07937fbb4d04fdc8591443f28473700c084fcde973118901dc8f566b4c85d7ace85e51509585f9fbd7dd922a7042b97349db1a4246a07000000b99440000000000279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ef17cca94bf415ed',
  '033e82dceca8de7687f4cdbd835e3e3c8e891d5154317b4cfcb0575295e3b053616334159eb1cafe53d00b2ee85427b29774f84cd86639917b80aa0b00d777957ba8fe41c2e2db5eedcea6ab003779b7904373923208e280c613759f714c0ccc9877fbdef606e6da97c11f3878093a84dcad5caab5def1046c8f5945699be99ced0080dbf4de9731811d928dcb52ba641fda8b7f9b99286eb364faf6807f2c3588956db9c05180c707000000b89440000000000279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f8179864ab88b755197af6',
  '03efa3b5fcfce4edb8cff5f2e0d7b8c225f903f865a1e1b14b6aa0d986b314e4c2f890b200cdcb7437da1359556a5c5c77dad25115406026271581740ba2cdcd0464efe064fc410db364e5d6f18abd798db39ab4420facdcc24fcce934f4a1e5c7d9a4b1abbb9f967b478cf5d9eb7e211031961132d9deb80816f6b3bc4444255c00c0b1edde9731175467cdb83a812d33adeebced82b7ed2a7ebe9f2fcd4bb61d52135bd5a150ff07000000b79440000000000279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798d85a6b82d6a0d208',
]

const SHARED = {
  data_input_boxes_hex: [],
  headers_hex: HEADERS,
  preHeader: {
    version: 3,
    parentId: 'f9cffe9b07f6a9a8d745953cede03e2648596d657eb96448da96de5f81ab82a4',
    timestamp: '1690001200000',
    nBits: 117440512,
    height: 1051200,
    minerPk: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    votes: '000000',
  },
  parameters: {
    maxBlockCost: 1000000,
    storageFeeFactor: 1250000,
    minValuePerByte: 360,
    inputCost: 2000,
    dataInputCost: 100,
    outputCost: 100,
    tokenAccessCost: 100,
  },
}

const LADDER_129_FIRST_TRUE: SantaTxEntry = {
  ...SHARED,
  name: 'and-or-item-by-item-spend-OR-ladder-L129-k0-tv0-a2#127',
  tx_bytes_hex: '0137b46204216188f70cc4a423c23f6230bc6b69b66737a550afc72acfc7fe4e2600000000018094ebdc030008d3010000',
  input_boxes_hex: ['8094ebdc0300d1970d810101000000000000000000000000000000000100001745169c8b266c80d82278f05211ec23d55c6b3c5bc80ae1d0940cbfe4c629d900'],
  expected: { valid: true, cost: 12103, reason: null },
}

const TUPLE_BYTE_BEHIND_THE_DECIDING_ITEM: SantaTxEntry = {
  ...SHARED,
  name: 'and-or-item-by-item-spend-OR-tuple-dKn-Byte0-tv0-a2#142',
  tx_bytes_hex: '01044bc9cc08a2e112645a05fa4dd3dc6673204929f7fdf80f75c54a93b8a7a0c900000000018094ebdc030008d3010000',
  input_boxes_hex: ['8094ebdc0300d197480102010100000100008d02715acff04ab876698ba83546c51d027a79b671b2b49d0a0061d9150e3df500'],
  expected: { valid: true, cost: 12103, reason: null },
}

const TUPLE_IN_A_SEGREGATED_COLLECTION: SantaTxEntry = {
  ...SHARED,
  name: 'segregated-tuple-OR-phColl-dKn-v0-a2#53',
  tx_bytes_hex: '01066568be95ed9fd5f79eb17546524c75c82a9145e9f0fa73d7f2466622a2aeb40000000001c0843d0008d3640000',
  input_boxes_hex: ['c0843d10010c4801040101010a00d197b27300040000640000111111111111111111111111111111111111111111111111111111111111111100'],
  expected: { valid: true, cost: 12106, reason: null },
}

describe('a spend through OR is charged for the items OR read', () => {
  for (const e of [LADDER_129_FIRST_TRUE, TUPLE_BYTE_BEHIND_THE_DECIDING_ITEM, TUPLE_IN_A_SEGREGATED_COLLECTION]) {
    it(`${e.name}: valid at block cost ${e.expected.cost}`, () => {
      const { tx, deps } = santaTxInputs(e)
      expect(validateStateful(tx, deps)).toBe(e.expected.cost)
    })
  }
})
