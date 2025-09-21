# Windows Code Signing Github Action

[![build-test](https://github.com/mscrivo/signtool-code-sign/actions/workflows/build.yml/badge.svg)](https://github.com/mscrivo/signtool-code-sign/actions/workflows/build.yml)

Forked from: <https://github.com/GabrielAcostaEngler/signtool-code-sign> but modernized and with updated dependencies.

This action will code sign files from the given folder, this can be done recursively if needed.  
The action uses a base64 encoded PFX certificate to sign files by adding the certificate to the store and then use `signtool.exe` to do the code signing.

All inputs regarding the Certificate except `description` should be added via repository/organization secrets.

Thanks to [Dirk Lemstra](https://github.com/dlemstra/code-sign-action) and [Gabriel Acosta Engler](https://github.com/GabrielAcostaEngler/signtool-code-sign) for providing a base for this action.

## Inputs

## `certificate`

**Required**  
**Description** - The base64 encoded certificate.

## `cert-password`

**Required**  
**Description** - Certificate Password. Used to add to the machine store.

## `cert-sha1`

**Required**  
**Description** - SHA1 hash for the certificate (Thumbprint of the certificate).

## `cert-description`

**Description** - Add a description to the files being signed.

## `folder`

**Required**  
**Description** - The folder that contains the libraries to sign.

## `recursive`

**Description** - Recursively search for DLL files.  
**Default** - 'false'

## `timestamp-server`

**Description** - Url of the timestamp server.  
**Default** - '<http://timestamp.verisign.com/scripts/timstamp.dll>'

## Usage

```yaml
runs-on: windows-latest
steps:
  uses: mscrivo/signtool-code-sign@v1
  with:
    certificate: '${{ secrets.CERTIFICATE }}'
    cert-password: '${{ secrets.PASSWORD }}'
    cert-sha1: '${{ secrets.CERTHASH }}'
    cert-description: 'foo'
    folder: 'path/to/folder'
    recursive: true
    timestamp-server: 'http://timestamp.digicert.com'
```

## Publishing a New Version

To publish a new version of this action:

1. **Update the code** and ensure all tests pass:

   ```bash
   npm test
   npm run build
   ```

2. **Package the action** for distribution:

   ```bash
   npm run package
   ```

   This compiles the TypeScript code and bundles all dependencies into the `dist/` folder that GitHub Actions will use.

3. **Commit the changes** including the updated `dist/` folder:

   ```bash
   git add .
   git commit -m "Release version x.x.x"
   ```

4. **Create and push a new version tag**:

   ```bash
   git tag -a v1.x.x -m "Release version 1.x.x"
   git push origin v1.x.x
   ```

5. **Update the major version tag** to point to the latest release:

   ```bash
   git tag -fa v1 -m "Update v1 tag to point to v1.x.x"
   git push origin v1 --force
   ```

   This ensures that users referencing `@v1` in their workflows will automatically get the latest v1.x.x release.

6. **Create a GitHub release** (optional):
   - Go to the repository on GitHub
   - Click "Releases" → "Create a new release"
   - Select the tag you just created (v1.x.x)
   - Add release notes describing the changes
   - Publish the release

**Note**: Always run `npm run package` before creating a new release, as this ensures the `dist/` folder contains the latest compiled code that GitHub Actions will execute.

## License

This project is released under the [MIT License](LICENSE)
