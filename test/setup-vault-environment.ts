// Each fixture chooses its vault and indexing settings after this setup runs.
// Clear every spelling because Windows environment names are case-insensitive.
for (const name of Object.keys(process.env)) {
  if (name.toUpperCase().startsWith('OBSIDIAN_')) delete process.env[name];
}
