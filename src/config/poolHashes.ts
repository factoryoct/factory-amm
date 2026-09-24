export const POOL_CODE_HASHES = new Set<string>([
  '33f6bc0850b86d5cf39693dd97ddf2c40871ea705628d110254ac7f9c8201a05',
  'a6e2709bb2023513ae31bd725e95c78b7db7477f054e96a4df40c0cdb2108187',
  '34fbb5733030725993e64902b8f7b89564141ea02f0eb8998477d102a6498f2d',
  'bb66e723a0c41032e52ea123cc0d5e47390582bf8e5be640b857737caf70e0ba',
  '1aa8dc5600bafc8691ac1a2ebed78d3ed8834cc1686a1fa2971ef126c8f30467',
  'c413b152751e31e70674f22e97af07fb7f50387d35e9cbcad01a689264e0da2d',
  'bac4b8d979e459aa780ff04c48863873e9295a815b1001154fc3f18f1e906185',
  '3f5bb125ffff13e9b27f60c470510ec2f3aca7094e258a0744f415262ac14272',
  ...(() => {
    try { return (localStorage.getItem('oct_pool_hashes') || '').split(',').map(s => s.trim()).filter(Boolean) }
    catch { return [] }
  })(),
])
