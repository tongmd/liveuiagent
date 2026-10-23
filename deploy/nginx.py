"""Update only the /liveui locations inside one explicitly selected server block."""
import re


def blocks(source):
    clean = list(source)
    quote = None
    escaped = False
    comment = False
    for i, char in enumerate(source):
        if comment:
            if char == '\n': comment = False
            else: clean[i] = ' '
        elif escaped: escaped = False
        elif char == '\\': escaped = True
        elif quote:
            if char == quote: quote = None
        elif char in ('"', "'"): quote = char
        elif char == '#': clean[i] = ' '; comment = True
    clean = ''.join(clean)
    result, stack = [], []
    start = 0
    quote = None
    escaped = False
    for i, char in enumerate(clean):
        if escaped: escaped = False; continue
        if char == '\\': escaped = True; continue
        if quote:
            if char == quote: quote = None
            continue
        if char in ('"', "'"): quote = char; continue
        if char == '{':
            node = {'start': start, 'body': i + 1, 'header': clean[start:i].strip(), 'children': []}
            (stack[-1]['children'] if stack else result).append(node)
            stack.append(node); start = i + 1
        elif char == ';':
            node = {'start': start, 'end': i + 1, 'header': clean[start:i].strip()}
            (stack[-1]['children'] if stack else result).append(node); start = i + 1
        elif char == '}':
            if not stack: raise ValueError('Unbalanced nginx configuration')
            node = stack.pop(); node['close'] = i; node['end'] = i + 1; start = i + 1
    if stack or quote: raise ValueError('Unbalanced nginx configuration')
    return result


def install_include(source, snippet, server_name=None):
    def walk(nodes):
        for node in nodes:
            yield node
            yield from walk(node.get('children', []))
    servers = [node for node in walk(blocks(source)) if node['header'] == 'server']
    if server_name:
        servers = [node for node in servers if any(child['header'].split()[:1] == ['server_name'] and server_name in child['header'].split()[1:] for child in node['children'])]
    if len(servers) != 1: raise ValueError('Select exactly one nginx server with --server-name; unrelated server blocks are never modified')
    server = servers[0]
    include = 'include ' + snippet
    existing = [node for node in server['children'] if node['header'] == include]
    locations = [node for node in server['children'] if re.fullmatch(r'location\s+(?:(?:=|\^~)\s+)?/liveui/?', node['header'])]
    for node in server['children']:
        if node['header'].startswith('location ') and re.search(r'(?<![A-Za-z0-9_-])/liveui(?:/|[\s$])', node['header']) and node not in locations:
            raise ValueError('Complex /liveui location requires an explicit operator migration; configuration was not changed')
    if existing and not locations: return source
    replacements = []
    for index, node in enumerate(locations):
        replacements.append((node['start'], node['end'], '\n    '+include+';\n' if index == 0 and not existing else ''))
    if not existing and not locations: replacements.append((server['close'], server['close'], '\n    '+include+';\n'))
    for start, end, value in sorted(replacements, reverse=True): source = source[:start] + value + source[end:]
    return source


def snippet(port, auth_file):
    if not (1024 <= int(port) <= 65535): raise ValueError('Port must be 1024–65535')
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', auth_file) or '..' in auth_file.split('/'): raise ValueError('Unsafe auth file path')
    return '''# Managed by LiveUIAgent deployment. No root redirect or legacy routes.
location = /liveui { return 308 /liveui/$is_args$args; }
location ^~ /liveui/ {
    auth_basic "LiveUIAgent";
    auth_basic_user_file %s;
    proxy_pass http://127.0.0.1:%s/;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-LiveUIAgent-User $remote_user;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Prefix /liveui;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 1800s;
    proxy_send_timeout 1800s;
    client_max_body_size 5m;
}
''' % (auth_file, int(port))
