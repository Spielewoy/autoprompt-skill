/* uinfo.cc: user info (uid, gid, etc...)

This file is part of Cygwin.

This software is a copyrighted work licensed under the terms of the
Cygwin license.  Please consult the file "CYGWIN_LICENSE" for
details. */

void
cygheap_user::init ()
{
  WCHAR user_name[UNLEN + 1];
  DWORD user_name_len = UNLEN + 1;

  /* This method is only called if a Cygwin process gets started by a
     native Win32 process.  Try to get the username from the environment,
     first USERNAME (Win32), then USER (POSIX).  If that fails (which is
     very unlikely), it only has an impact if we don't have an entry in
     /etc/passwd for this user either.  In that case the username sticks
     to "unknown".  Since this is called early in initialization, and
     since we don't want to pull in a dependency to any other DLL except
     ntdll and kernel32 at this early stage, don't call GetUserName,
     GetUserNameEx, NetWkstaUserGetInfo, etc. */
  if (GetEnvironmentVariableW (L"USERNAME", user_name, user_name_len)
      || GetEnvironmentVariableW (L"USER", user_name, user_name_len))
    {
      char mb_user_name[user_name_len = sys_wcstombs (NULL, 0, user_name) + 1];
      sys_wcstombs (mb_user_name, user_name_len, user_name);
      set_name (mb_user_name);
    }
  else
    set_name ("unknown");

  NTSTATUS status;
  ULONG size;
  PSECURITY_DESCRIPTOR psd;

  status = NtQueryInformationToken (hProcToken, TokenPrimaryGroup,
				    &groups.pgsid, sizeof (cygsid), &size);
  if (!NT_SUCCESS (status))
    system_printf ("NtQueryInformationToken (TokenPrimaryGroup), %y", status);

  /* Get the SID from current process and store it in effec_cygsid */
  status = NtQueryInformationToken (hProcToken, TokenUser, &effec_cygsid,
				    sizeof (cygsid), &size);
  if (!NT_SUCCESS (status))
    {
      system_printf ("NtQueryInformationToken (TokenUser), %y", status);
      return;
    }

  /* Set token owner to the same value as token user */
  status = NtSetInformationToken (hProcToken, TokenOwner, &effec_cygsid,
				  sizeof (cygsid));
  if (!NT_SUCCESS (status))
    debug_printf ("NtSetInformationToken (TokenOwner), %y", status);

  /* Standard way to build a security descriptor with the usual DACL */
  PSECURITY_ATTRIBUTES sa_buf = (PSECURITY_ATTRIBUTES) alloca (1024);
  psd = (PSECURITY_DESCRIPTOR)
		(sec_user_nih (sa_buf, sid()))->lpSecurityDescriptor;

  BOOLEAN acl_exists, dummy;
  TOKEN_DEFAULT_DACL dacl;

  status = RtlGetDaclSecurityDescriptor (psd, &acl_exists, &dacl.DefaultDacl,
					 &dummy);
  if (NT_SUCCESS (status) && acl_exists && dacl.DefaultDacl)
    {

      /* Set the default DACL and the process DACL */
      status = NtSetInformationToken (hProcToken, TokenDefaultDacl, &dacl,
				      sizeof (dacl));
      if (!NT_SUCCESS (status))
	system_printf ("NtSetInformationToken (TokenDefaultDacl), %y", status);
      if ((status = NtSetSecurityObject (NtCurrentProcess (),
					 DACL_SECURITY_INFORMATION, psd)))
	system_printf ("NtSetSecurityObject, %y", status);
    }
  else
    system_printf("Cannot get dacl, %E");
}
